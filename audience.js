import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { FOG_COLOR, makeShadow, makeShadowTexture } from './audience-support.js';

const VRM_URL = './audience.vrm';
const WALK_URL = './walking.glb';
// Match the world-space body length of the pondpose character: its raw
// 2.602-unit pose is authored at scale 1.9.
const TARGET_HEIGHT = 3.904; // another 10% larger
const WALK_SPEED = 3.0; // 1.5x walking speed
const FENCE_CLEARANCE = 6.3;
const OUTER_LIMIT = 16.15;
const AUDIENCE_RADIUS = 1.3;

const HUMANOID_TO_MIXAMO = {
  hips: 'mixamorig_Hips',
  spine: 'mixamorig_Spine',
  chest: 'mixamorig_Spine1',
  upperChest: 'mixamorig_Spine2',
  neck: 'mixamorig_Neck',
  head: 'mixamorig_Head',
  leftShoulder: 'mixamorig_LeftShoulder',
  leftUpperArm: 'mixamorig_LeftArm',
  leftLowerArm: 'mixamorig_LeftForeArm',
  leftHand: 'mixamorig_LeftHand',
  rightShoulder: 'mixamorig_RightShoulder',
  rightUpperArm: 'mixamorig_RightArm',
  rightLowerArm: 'mixamorig_RightForeArm',
  rightHand: 'mixamorig_RightHand',
  leftUpperLeg: 'mixamorig_LeftUpLeg',
  leftLowerLeg: 'mixamorig_LeftLeg',
  leftFoot: 'mixamorig_LeftFoot',
  leftToes: 'mixamorig_LeftToeBase',
  rightUpperLeg: 'mixamorig_RightUpLeg',
  rightLowerLeg: 'mixamorig_RightLeg',
  rightFoot: 'mixamorig_RightFoot',
  rightToes: 'mixamorig_RightToeBase',
};

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getBuffer(url, globalName) {
  const encoded = window[globalName];
  if (encoded) return decodeBase64(encoded);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.arrayBuffer();
}

function parseGLTF(loader, buffer) {
  return new Promise((resolve, reject) => {
    loader.parse(buffer, '', resolve, reject);
  });
}


function buildRetargetedClips(vrm, walkGltf) {
  const walkClip = walkGltf.animations[0];
  if (!walkClip) throw new Error('Walking.glb has no animation clip.');

  let sourceMesh = null;
  walkGltf.scene.traverse((object) => {
    if (!sourceMesh && object.isSkinnedMesh) sourceMesh = object;
  });
  if (!sourceMesh) throw new Error('Walking.glb has no skinned mesh.');

  const sourceBones = new Map();
  for (const [humanoidName, sourceName] of Object.entries(HUMANOID_TO_MIXAMO)) {
    const bone = sourceMesh.skeleton.bones.find((candidate) => candidate.name === sourceName);
    if (bone) sourceBones.set(humanoidName, bone);
  }
  const targetBones = new Map();
  for (const humanoidName of Object.keys(HUMANOID_TO_MIXAMO)) {
    const node = vrm.humanoid.getNormalizedBoneNode(humanoidName);
    if (node && sourceBones.has(humanoidName)) targetBones.set(humanoidName, node);
  }

  walkGltf.scene.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);
  const sourceRestLocal = new Map();
  const sourceRestWorld = new Map();
  const targetRestLocal = new Map();
  const targetRestWorld = new Map();
  const parentRestWorld = new Map();
  for (const [humanoidName, targetNode] of targetBones) {
    const sourceBone = sourceBones.get(humanoidName);
    sourceRestLocal.set(humanoidName, sourceBone.quaternion.clone());
    const sw = new THREE.Quaternion();
    sourceBone.getWorldQuaternion(sw);
    sourceRestWorld.set(humanoidName, sw);
    targetRestLocal.set(humanoidName, targetNode.quaternion.clone());
    const tw = new THREE.Quaternion();
    targetNode.getWorldQuaternion(tw);
    targetRestWorld.set(humanoidName, tw);
    const pw = new THREE.Quaternion();
    if (targetNode.parent) targetNode.parent.getWorldQuaternion(pw);
    parentRestWorld.set(humanoidName, pw);
  }

  const parentNames = new Map();
  for (const [humanoidName, targetNode] of targetBones) {
    let ancestor = targetNode.parent;
    let parentName = null;
    while (ancestor) {
      for (const [candidateName, candidateNode] of targetBones) {
        if (candidateNode === ancestor) { parentName = candidateName; break; }
      }
      if (parentName) break;
      ancestor = ancestor.parent;
    }
    parentNames.set(humanoidName, parentName);
  }
  const order = [...targetBones.keys()].sort((a, b) => {
    const depth = (name) => {
      let d = 0;
      let current = parentNames.get(name);
      while (current) { d++; current = parentNames.get(current); }
      return d;
    };
    return depth(a) - depth(b);
  });

  const fps = 30;
  const frameCount = Math.max(2, Math.ceil(walkClip.duration * fps));
  const times = new Float32Array(frameCount);
  const samples = new Map();
  for (const name of targetBones.keys()) samples.set(name, new Float32Array(frameCount * 4));

  const leftHipAngles = new Float32Array(frameCount);
  const leftKneeAngles = new Float32Array(frameCount);
  const rightHipAngles = new Float32Array(frameCount);
  const rightKneeAngles = new Float32Array(frameCount);

  const sourceMixer = new THREE.AnimationMixer(walkGltf.scene);
  sourceMixer.clipAction(walkClip).play();
  const inverseSourceRestLocal = new THREE.Quaternion();
  const deltaLocal = new THREE.Quaternion();
  const deltaWorld = new THREE.Quaternion();
  const targetWorld = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();
  const localQ = new THREE.Quaternion();
  const desiredWorlds = new Map();
  const hipPos = new THREE.Vector3();
  const kneePos = new THREE.Vector3();
  const footPos = new THREE.Vector3();
  const thigh = new THREE.Vector3();
  const calf = new THREE.Vector3();

  const readLegAngles = (upperName, lowerName, footName, hipOut, kneeOut, index) => {
    const upper = sourceBones.get(upperName);
    const lower = sourceBones.get(lowerName);
    const foot = sourceBones.get(footName);
    if (!upper || !lower || !foot) return;
    upper.getWorldPosition(hipPos);
    lower.getWorldPosition(kneePos);
    foot.getWorldPosition(footPos);
    thigh.subVectors(kneePos, hipPos);
    calf.subVectors(footPos, kneePos);
    // Source is authored facing +Z. Keep only the sagittal component;
    // lateral and twist components are deliberately discarded.
    const hipAngle = Math.atan2(thigh.z, -thigh.y);
    const calfAngle = Math.atan2(calf.z, -calf.y);
    hipOut[index] = THREE.MathUtils.clamp(hipAngle, -1.05, 1.05);
    kneeOut[index] = THREE.MathUtils.clamp(hipAngle - calfAngle, 0, 1.4);
  };

  for (let frame = 0; frame < frameCount; frame++) {
    const time = frame / fps;
    times[frame] = time;
    sourceMixer.setTime(time % walkClip.duration);
    walkGltf.scene.updateMatrixWorld(true);
    readLegAngles('leftUpperLeg', 'leftLowerLeg', 'leftFoot', leftHipAngles, leftKneeAngles, frame);
    readLegAngles('rightUpperLeg', 'rightLowerLeg', 'rightFoot', rightHipAngles, rightKneeAngles, frame);
    desiredWorlds.clear();
    for (const humanoidName of order) {
      const sourceBone = sourceBones.get(humanoidName);
      inverseSourceRestLocal.copy(sourceRestLocal.get(humanoidName)).invert();
      deltaLocal.copy(inverseSourceRestLocal).multiply(sourceBone.quaternion);
      deltaWorld.copy(sourceRestWorld.get(humanoidName))
        .multiply(deltaLocal)
        .multiply(sourceRestWorld.get(humanoidName).clone().invert());
      targetWorld.copy(deltaWorld).multiply(targetRestWorld.get(humanoidName));

      const parentName = parentNames.get(humanoidName);
      if (parentName && desiredWorlds.has(parentName)) {
        parentWorld.copy(desiredWorlds.get(parentName));
      } else {
        parentWorld.copy(parentRestWorld.get(humanoidName));
      }
      localQ.copy(parentWorld).invert().multiply(targetWorld).normalize();
      localQ.toArray(samples.get(humanoidName), frame * 4);
      desiredWorlds.set(humanoidName, targetWorld.clone());
    }
  }
  sourceMixer.stopAllAction();

  const xAxis = new THREE.Vector3(1, 0, 0);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const zAxis = new THREE.Vector3(0, 0, 1);
  const legHipQ = new THREE.Quaternion();
  const legKneeQ = new THREE.Quaternion();
  const legUpperQ = new THREE.Quaternion();
  const legLowerQ = new THREE.Quaternion();
  // Keep each upper arm 15 degrees away from vertical while walking.
  const armOutAngle = Math.PI / 2 - THREE.MathUtils.degToRad(15);
  const armDownLeft = new THREE.Quaternion().setFromAxisAngle(zAxis, -armOutAngle);
  const armDownRight = new THREE.Quaternion().setFromAxisAngle(zAxis, armOutAngle);
  const armSwingQ = new THREE.Quaternion();
  const armLeft = new THREE.Quaternion();
  const armRight = new THREE.Quaternion();
  const elbowQ = new THREE.Quaternion();
  const wristQ = new THREE.Quaternion();
  const lowerArmL = new THREE.Quaternion();
  const lowerArmR = new THREE.Quaternion();
  const handL = new THREE.Quaternion();
  const handR = new THREE.Quaternion();
  const torsoPitchQ = new THREE.Quaternion();
  const torsoSideQ = new THREE.Quaternion();
  const spineQ = new THREE.Quaternion();
  const chestQ = new THREE.Quaternion();
  const upperChestQ = new THREE.Quaternion();
  const hipsWorld = new THREE.Quaternion();
  const spineWorld = new THREE.Quaternion();
  const chestWorld = new THREE.Quaternion();
  const upperChestWorld = new THREE.Quaternion();
  const neckWorld = new THREE.Quaternion();
  const headLocal = new THREE.Quaternion();

  // The VRM normalized leg's local X is the sagittal hinge. The source clip's
  // lateral and twist components are discarded here, and the sagittal angles
  // are applied to both thighs and calves with the correct VRM local sign.
  for (let frame = 0; frame < frameCount; frame++) {
    const write = (humanoidName, q) => {
      if (!samples.has(humanoidName)) return;
      q.toArray(samples.get(humanoidName), frame * 4);
    };
    // Keep the pelvis stable so the sagittal leg rotations cannot drift
    // sideways as a side effect of source hip yaw/roll.
    write('hips', targetRestLocal.get('hips'));

    legHipQ.setFromAxisAngle(xAxis, -leftHipAngles[frame]);
    legKneeQ.setFromAxisAngle(xAxis, leftKneeAngles[frame]);
    legUpperQ.copy(targetRestLocal.get('leftUpperLeg')).multiply(legHipQ).normalize();
    legLowerQ.copy(targetRestLocal.get('leftLowerLeg')).multiply(legKneeQ).normalize();
    write('leftUpperLeg', legUpperQ);
    write('leftLowerLeg', legLowerQ);
    write('leftFoot', targetRestLocal.get('leftFoot'));

    legHipQ.setFromAxisAngle(xAxis, -rightHipAngles[frame]);
    legKneeQ.setFromAxisAngle(xAxis, rightKneeAngles[frame]);
    legUpperQ.copy(targetRestLocal.get('rightUpperLeg')).multiply(legHipQ).normalize();
    legLowerQ.copy(targetRestLocal.get('rightLowerLeg')).multiply(legKneeQ).normalize();
    write('rightUpperLeg', legUpperQ);
    write('rightLowerLeg', legLowerQ);
    write('rightFoot', targetRestLocal.get('rightFoot'));

    // Contralateral arm swing: reverse the leg phase so the arm opposite
    // the forward leg swings forward.
    const phase = (frame / frameCount) * Math.PI * 2;
    // Drive the upper arm directly from the same hip angle that moves the
    // leg. Do not clamp it, otherwise the arms stall while the legs continue.
    const swing = -rightHipAngles[frame];
    armSwingQ.setFromAxisAngle(yAxis, swing);
    armLeft.copy(armDownLeft).multiply(armSwingQ).normalize();
    armRight.copy(armDownRight).multiply(armSwingQ).normalize();
    write('leftUpperArm', armLeft);
    write('rightUpperArm', armRight);
    write('leftShoulder', targetRestLocal.get('leftShoulder'));
    write('rightShoulder', targetRestLocal.get('rightShoulder'));

    // Elbow follows the upper arm with a soft lag. The VRM normalized
    // forearm hinge is local Y, with mirrored signs on the two sides.
    const elbowBend = 0.48 + Math.sin(phase - 0.62) * 0.11;
    elbowQ.setFromAxisAngle(yAxis, -elbowBend);
    lowerArmL.copy(targetRestLocal.get('leftLowerArm')).multiply(elbowQ).normalize();
    elbowQ.setFromAxisAngle(yAxis, elbowBend);
    lowerArmR.copy(targetRestLocal.get('rightLowerArm')).multiply(elbowQ).normalize();
    write('leftLowerArm', lowerArmL);
    write('rightLowerArm', lowerArmR);

    // A very small trailing wrist rotation keeps the hand chain from looking
    // like a single rigid stick.
    const wristTrail = Math.sin(phase - 1.18) * 0.055;
    wristQ.setFromAxisAngle(xAxis, wristTrail);
    handL.copy(targetRestLocal.get('leftHand')).multiply(wristQ).normalize();
    wristQ.setFromAxisAngle(xAxis, wristTrail * 0.8);
    handR.copy(targetRestLocal.get('rightHand')).multiply(wristQ).normalize();
    write('leftHand', handL);
    write('rightHand', handR);

    // Soft torso: a small constant forward lean, a gentle lateral shift and
    // only a tiny vertical undulation. The source's large torso rotations are
    // replaced so the body does not rock backward on a step.
    const sideSway = Math.sin(phase) * 0.026;
    const softBob = Math.sin(phase * 2) * 0.009;
    torsoPitchQ.setFromAxisAngle(xAxis, 0.052 + softBob);
    torsoSideQ.setFromAxisAngle(zAxis, sideSway);
    spineQ.copy(targetRestLocal.get('spine')).multiply(torsoPitchQ).multiply(torsoSideQ).normalize();
    write('spine', spineQ);

    torsoPitchQ.setFromAxisAngle(xAxis, 0.028 + softBob * 0.45);
    torsoSideQ.setFromAxisAngle(zAxis, sideSway * 0.55);
    chestQ.copy(targetRestLocal.get('chest')).multiply(torsoPitchQ).multiply(torsoSideQ).normalize();
    write('chest', chestQ);

    torsoPitchQ.setFromAxisAngle(xAxis, 0.012 + softBob * 0.2);
    torsoSideQ.setFromAxisAngle(zAxis, sideSway * 0.25);
    upperChestQ.copy(targetRestLocal.get('upperChest')).multiply(torsoPitchQ).multiply(torsoSideQ).normalize();
    write('upperChest', upperChestQ);

    // Keep the head world orientation fixed while the torso moves underneath.
    // Neck stays in its rest local orientation; the head counter-rotates the
    // accumulated torso rotation.
    write('neck', targetRestLocal.get('neck'));
    hipsWorld.copy(targetRestWorld.get('hips'));
    spineWorld.copy(hipsWorld).multiply(spineQ);
    chestWorld.copy(spineWorld).multiply(chestQ);
    upperChestWorld.copy(chestWorld).multiply(upperChestQ);
    neckWorld.copy(upperChestWorld).multiply(targetRestLocal.get('neck'));
    headLocal.copy(neckWorld).invert().multiply(targetRestWorld.get('head')).normalize();
    write('head', headLocal);
  }

  const walkTracks = [];
  const idleTracks = [];
  for (const [humanoidName, data] of samples) {
    const node = targetBones.get(humanoidName);
    walkTracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, data));
    let idleQ = targetRestLocal.get(humanoidName);
    if (humanoidName === 'leftUpperArm') idleQ = armDownLeft;
    if (humanoidName === 'rightUpperArm') idleQ = armDownRight;
    if (humanoidName === 'leftLowerArm') {
      idleQ = targetRestLocal.get('leftLowerArm').clone()
        .multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.34));
    }
    if (humanoidName === 'rightLowerArm') {
      idleQ = targetRestLocal.get('rightLowerArm').clone()
        .multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.34));
    }
    idleTracks.push(new THREE.QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      [0, 1],
      [idleQ.x, idleQ.y, idleQ.z, idleQ.w, idleQ.x, idleQ.y, idleQ.z, idleQ.w]
    ));
  }
  return {
    walkClip: new THREE.AnimationClip('walk', walkClip.duration, walkTracks),
    idleClip: new THREE.AnimationClip('idle', 1, idleTracks),
  };
}



function applyEnvironmentTone(vrm) {
  // The audience should sit in the same cold, damp green-gray light as the
  // rest of the courtyard: darken the base colors and pull them toward the
  // scene fog color without flattening the original texture detail.
  const environmentTint = new THREE.Color(0.96, 0.89, 0.79);
  environmentTint.lerp(FOG_COLOR, 0.1);
  environmentTint.multiplyScalar(0.82);

  const tone = (color) => {
    color.multiply(environmentTint);
    return color;
  };

  vrm.scene.traverse((object) => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      // The VRM loader appends a second inverted-hull material for the MToon
      // outline. It reads as an edge ghost/double image at this scale.
      if (material.isOutline) {
        material.colorWrite = false;
        material.depthWrite = false;
        material.transparent = true;
        material.opacity = 0;
        material.needsUpdate = true;
        continue;
      }
      if (material.color) tone(material.color);
      if (material.shadeColorFactor) tone(material.shadeColorFactor);
      if (material.map) {
        material.map.anisotropy = 8;
        material.map.magFilter = THREE.LinearFilter;
        material.map.minFilter = THREE.LinearMipmapLinearFilter;
        material.map.generateMipmaps = true;
        material.map.needsUpdate = true;
      }
      if (material.emissive) material.emissive.setRGB(0, 0, 0);
      if ('emissiveIntensity' in material) material.emissiveIntensity = 0;
      if (material.rimColorFactor) material.rimColorFactor.setRGB(0, 0, 0);
      if ('rimLightingMixFactor' in material) material.rimLightingMixFactor = 0;
      if (material.matcapTexture) material.matcapTexture = null;

      // Keep the opaque body and clothing single-layered. The VRM's
      // double-sided opaque materials can otherwise show backfaces through
      // seams and read as a second overlapping silhouette.
      material.blending = THREE.NormalBlending;
      material.depthTest = true;

      // Facial overlays (brows, eyelines, irises, eye highlights and mouth)
      // rely on their source alpha maps. Forcing them opaque makes the brows
      // render as thick blocks, so keep their original transparent/double-side
      // settings while still applying the light grade above.
      const isFaceOverlay = /(Eye|Brow|Eyeline|Mouth)/i.test(material.name || '');
      if (!isFaceOverlay && (!material.transparent || material.opacity >= 0.999)) {
        material.transparent = false;
        material.depthWrite = true;
        material.side = THREE.FrontSide;
      }
      material.needsUpdate = true;
    }
  });
}

let activeAudience = null;

export function createAudience({ position, rotation = 0, onReady, onError } = {}) {
  activeAudience?.userData.dispose?.();
  activeAudience?.removeFromParent();

  const group = new THREE.Group();
  group.name = 'Audience';
  activeAudience = group;
  if (position) group.position.copy(position);
  group.rotation.y = rotation;

  let vrm = null;
  let mixer = null;
  let idleAction = null;
  let walkAction = null;
  let walking = false;
  let disposed = false;
  let walkDuration = 1;
  let baseSceneY = 0;
  const moveInput = { x: 0, y: 0, magnitude: 0 };
  let joystickMoving = false;
  let externalWalking = false;
  let fenceCollisionEnabled = true;
  const baseGroupY = group.position.y;
  let waterSink = 0;
  let waterSinkTarget = 0;
  let fenceStepLift = 0;
  let fenceStepLiftTarget = 0;
  let movementLocked = false;
  let umbrellaShelterTarget = null;
  const moveForward = new THREE.Vector3();
  const moveRight = new THREE.Vector3();
  const moveDirection = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  let lastFootstepIndex = -1;
  let onStep = null;
  const footstepWorld = new THREE.Vector3();
  let umbrellaMount = null;
  let umbrellaVisual = null;
  let phoneMount = null;
  let phoneSequence = null;
  let wateringCanMount = null;
  let wateringCanVisual = null;
  let wateringCanSpout = null;
  let wateringActive = false;
  const wateringTiltQ = new THREE.Quaternion();
  const wateringRollQ = new THREE.Quaternion();
  const wateringCanHandWorldQ = new THREE.Quaternion();
  const wateringCanYawQ = new THREE.Quaternion();
  let rightShoulderNode = null;
  let rightUpperArmNode = null;
  let rightLowerArmNode = null;
  let rightHandNode = null;
  let restRightShoulder = null;
  let restRightLowerArm = null;
  let restRightHand = null;
  const rightFingerRig = [];
  const fingerCurlQ = new THREE.Quaternion();
  const fingerCurlAxis = new THREE.Vector3(0, 0, 1);
  const heldUpperArmQ = new THREE.Quaternion();
  const heldLowerArmQ = new THREE.Quaternion();
  const heldHandQ = new THREE.Quaternion();
  const umbrellaHandWorldQuat = new THREE.Quaternion();
  const umbrellaTargetQuat = new THREE.Quaternion();
  const umbrellaTargetInvQuat = new THREE.Quaternion();
  const umbrellaTiltEuler = new THREE.Euler(0.1, 0, 0.08, 'YXZ');
  const umbrellaTiltDir = new THREE.Vector3();
  const umbrellaShelterDir = new THREE.Vector3();
  const thumbWorld = new THREE.Vector3();
  const indexWorld = new THREE.Vector3();
  const gripWorld = new THREE.Vector3();
  const gripLocal = new THREE.Vector3();
  const mountWorldPos = new THREE.Vector3();

  const sizeFactor = TARGET_HEIGHT / 1.55;
  const shadow = makeShadow(makeShadowTexture(), 1.05 * sizeFactor, 0.72 * sizeFactor, 0.34, 0.012);
  shadow.position.set(0, 0.012, 0);
  group.add(shadow);

  const applyWalking = () => {
    const next = externalWalking || joystickMoving;
    if (!mixer || !idleAction || !walkAction || walking === next) return;
    walking = next;
    const from = next ? idleAction : walkAction;
    const to = next ? walkAction : idleAction;
    to.reset();
    to.enabled = true;
    to.setEffectiveTimeScale(1);
    to.setEffectiveWeight(1);
    to.play();
    to.crossFadeFrom(from, 0.2, false);
  };

  const setWalking = (next) => {
    if (movementLocked) return;
    externalWalking = next;
    applyWalking();
  };

  const setMoveInput = (input) => {
    if (movementLocked) {
      moveInput.x = 0;
      moveInput.y = 0;
      moveInput.magnitude = 0;
      joystickMoving = false;
      return;
    }
    moveInput.x = Number(input?.x) || 0;
    moveInput.y = Number(input?.y) || 0;
    moveInput.magnitude = Math.min(1, Math.hypot(moveInput.x, moveInput.y));
    joystickMoving = moveInput.magnitude > 0.12;
    applyWalking();
  };

  const obstacles = [];
  const insideFence = (x, z) => Math.abs(x) < FENCE_CLEARANCE && Math.abs(z) < FENCE_CLEARANCE;
  const hitsObstacle = (x, z) => obstacles.some((box) => (
    x > box.min.x - AUDIENCE_RADIUS && x < box.max.x + AUDIENCE_RADIUS
    && z > box.min.z - AUDIENCE_RADIUS && z < box.max.z + AUDIENCE_RADIUS
  ));

  group.userData.setWalking = setWalking;
  group.userData.setMoveInput = setMoveInput;
  group.userData.onStep = (callback) => {
    onStep = callback;
  };
  group.userData.setFenceCollision = (enabled) => {
    fenceCollisionEnabled = Boolean(enabled);
  };
  group.userData.setWaterSink = (active) => {
    waterSinkTarget = active ? 0.52 : 0;
  };
  group.userData.setMovementLocked = (locked) => {
    movementLocked = Boolean(locked);
    if (movementLocked) {
      externalWalking = false;
      joystickMoving = false;
      moveInput.x = 0;
      moveInput.y = 0;
      moveInput.magnitude = 0;
      applyWalking();
    }
  };
  group.userData.setUmbrellaShelter = (target) => {
    if (!umbrellaMount || !umbrellaVisual || !target) return false;
    umbrellaShelterTarget = new THREE.Vector3(target.x, 0, target.z);
    return true;
  };
  group.userData.setObstacles = (boxes) => {
    obstacles.length = 0;
    for (const box of boxes ?? []) obstacles.push(box.clone());
  };

  group.userData.equipUmbrella = (visual) => {
    if (!vrm || !visual) return false;
    const hand = vrm.humanoid.getNormalizedBoneNode('rightHand')
      ?? vrm.humanoid.getNormalizedBoneNode('leftHand');
    if (!hand) return false;
    const mount = new THREE.Group();
    mount.name = 'UmbrellaMount';
    hand.add(mount);
    // The VRM scene is scaled up to pondpose size; cancel that inherited scale
    // so the umbrella keeps its original 1.4x scene size in the hand.
    mount.scale.setScalar(1 / (vrm.scene.scale.x || 1));
    visual.removeFromParent();
    visual.name = 'HeldUmbrella';
    visual.position.set(0, -0.16, 0);
    visual.quaternion.identity();
    visual.scale.setScalar(1.4);
    mount.add(visual);
    // Raise the right forearm into a 90-degree umbrella-holding pose. The
    // normalized right elbow hinges on local Y, and the upper arm swings
    // slightly forward so the hand sits naturally in front of the body.
    const armDownAngle = Math.PI / 2 - THREE.MathUtils.degToRad(15);
    heldUpperArmQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), armDownAngle);
    heldUpperArmQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5)).normalize();
    if (restRightLowerArm) {
      heldLowerArmQ.copy(restRightLowerArm)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(82)))
        .normalize();
    }
    if (restRightHand) heldHandQ.copy(restRightHand);
    umbrellaMount = mount;
    umbrellaVisual = visual;
    return true;
  };
  group.userData.equipWateringCan = (visual) => {
    if (!vrm || !visual) return false;
    const hand = vrm.humanoid.getNormalizedBoneNode('rightHand');
    if (!hand) return false;
    const mount = new THREE.Group();
    mount.name = 'WateringCanMount';
    hand.add(mount);
    mount.scale.setScalar(1 / (vrm.scene.scale.x || 1));
    visual.removeFromParent();
    visual.name = 'HeldWateringCan';
    // The can's origin is at its base; place the handle at the hand.
    visual.position.set(-0.80, -0.61, 0.0);
    visual.quaternion.identity();
    visual.scale.setScalar(1);
    mount.add(visual);

    const armDownAngle = Math.PI / 2 - THREE.MathUtils.degToRad(15);
    heldUpperArmQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), armDownAngle);
    heldUpperArmQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4)).normalize();
    if (restRightLowerArm) {
      heldLowerArmQ.copy(restRightLowerArm)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(82)))
        .normalize();
    }
    if (restRightHand) heldHandQ.copy(restRightHand);
    rightUpperArmNode = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    rightLowerArmNode = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
    rightHandNode = vrm.humanoid.getNormalizedBoneNode('rightHand');
    wateringCanSpout = new THREE.Object3D();
    wateringCanSpout.position.set(-1.03, 0.62, 0);
    visual.add(wateringCanSpout);
    wateringCanMount = mount;
    wateringCanVisual = visual;
    return true;
  };

  group.userData.getHeadWorld = (position) => {
    if (!vrm) return false;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (!head) return false;
    head.getWorldPosition(position);
    return true;
  };

  group.userData.equipPhone = (visual) => {
    if (!vrm || !visual) return false;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (!head) return false;
    if (phoneMount) phoneMount.removeFromParent();
    const mount = new THREE.Group();
    mount.name = 'PhoneMount';
    head.add(mount);
    mount.scale.setScalar(1 / (vrm.scene.scale.x || 1));
    visual.removeFromParent();
    visual.position.set(-0.24, 0.02, 0.02);
    visual.quaternion.identity();
    mount.add(visual);
    phoneMount = mount;
    return true;
  };

  const rotatePhoneBoneToward = (bone, end, target) => {
    if (!bone || !end) return;
    bone.updateWorldMatrix(true, true);
    end.updateWorldMatrix(true, true);
    const bonePos = new THREE.Vector3();
    const endPos = new THREE.Vector3();
    bone.getWorldPosition(bonePos);
    end.getWorldPosition(endPos);
    const from = endPos.sub(bonePos);
    const to = target.clone().sub(bonePos);
    if (from.lengthSq() < 1e-6 || to.lengthSq() < 1e-6) return;
    const delta = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    const worldQ = new THREE.Quaternion();
    bone.getWorldQuaternion(worldQ);
    const newWorld = delta.multiply(worldQ);
    const parentQ = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentQ);
    bone.quaternion.copy(parentQ.invert().multiply(newWorld));
    bone.updateWorldMatrix(true, true);
  };

  const solvePhoneArm = (target) => {
    for (let i = 0; i < 4; i++) {
      rotatePhoneBoneToward(rightLowerArmNode, rightHandNode, target);
      rotatePhoneBoneToward(rightUpperArmNode, rightHandNode, target);
    }
  };

  group.userData.answerPhone = (boothPosition, handset) => {
    if (!vrm || !handset || phoneSequence) return false;
    moveInput.x = 0;
    moveInput.y = 0;
    moveInput.magnitude = 0;
    joystickMoving = false;
    externalWalking = true;
    applyWalking();
    movementLocked = true;
    const booth = new THREE.Vector3().copy(boothPosition);
    const entryDir = group.position.clone().sub(booth);
    entryDir.y = 0;
    if (entryDir.lengthSq() < 1e-5) entryDir.set(Math.sin(group.rotation.y), 0, Math.cos(group.rotation.y));
    entryDir.normalize();
    const stand = booth.clone();
    stand.y = group.position.y;
    group.parent?.add(handset);
    handset.position.copy(booth);
    handset.visible = true;
    phoneSequence = {
      phase: 'step',
      t: 0,
      from: group.position.clone(),
      stand,
      booth,
      entryDir,
      handset,
      mount: null
    };
    return true;
  };

  group.userData.leavePhone = () => {
    if (!phoneSequence) {
      movementLocked = false;
      return false;
    }
    const booth = phoneSequence.booth;
    const away = phoneSequence.entryDir?.clone() ?? group.position.clone().sub(booth);
    away.y = 0;
    if (away.lengthSq() < 1e-5) away.set(Math.sin(group.rotation.y), 0, Math.cos(group.rotation.y));
    away.normalize();
    const exit = booth.clone().addScaledVector(away, 3.1);
    exit.y = group.position.y;
    phoneSequence.phase = 'leave';
    phoneSequence.t = 0;
    phoneSequence.from = group.position.clone();
    phoneSequence.stand = exit;
    if (phoneSequence.handset) phoneSequence.handset.visible = false;
    externalWalking = true;
    applyWalking();
    return true;
  };

  group.userData.setWatering = (active) => {
    wateringActive = Boolean(active);
  };

  group.userData.getWateringSpout = (position, direction) => {
    if (!wateringCanSpout) return false;
    wateringCanSpout.getWorldPosition(position);
    // Water falls perpendicular to the ground while watering.
    direction.set(0, -1, 0);
    return true;
  };

  group.userData.update = (time, delta = 0.016, camera = null) => {
    if (!mixer || !vrm) return;
    const dt = Math.min(Math.max(delta, 0.001), 0.05);
    waterSink += (waterSinkTarget - waterSink) * (1 - Math.exp(-dt * 9));
    if (waterSinkTarget === 0 && waterSink < 0.001) waterSink = 0;
    group.position.y = baseGroupY - waterSink;

    fenceStepLiftTarget = 0;
    fenceStepLift += (fenceStepLiftTarget - fenceStepLift) * (1 - Math.exp(-dt * 12));
    if (fenceStepLift < 0.001) fenceStepLift = 0;

    mixer.update(dt);

    if (phoneSequence) {
      phoneSequence.t += dt;
      if (phoneSequence.phase === 'step') {
        const k = Math.min(1, phoneSequence.t / 0.75);
        const eased = 1 - Math.pow(1 - k, 3);
        group.position.lerpVectors(phoneSequence.from, phoneSequence.stand, eased);
        if (k >= 1) {
          phoneSequence.phase = 'reach';
          phoneSequence.t = 0;
          externalWalking = false;
          applyWalking();
        }
      } else if (phoneSequence.phase === 'reach') {
        const boothTarget = phoneSequence.booth.clone();
        boothTarget.y += 0.15;
        solvePhoneArm(boothTarget);
        if (phoneSequence.t > 0.55) {
          const mount = new THREE.Group();
          mount.scale.setScalar(1 / (vrm.scene.scale.x || 1));
          rightHandNode.add(mount);
          phoneSequence.handset.removeFromParent();
          phoneSequence.handset.position.set(0, 0.055, 0.02);
          phoneSequence.handset.rotation.set(0, 0, Math.PI / 2);
          mount.add(phoneSequence.handset);
          phoneSequence.mount = mount;
          phoneSequence.phase = 'raise';
          phoneSequence.t = 0;
        }
      } else if (phoneSequence.phase === 'raise') {
        const head = vrm.humanoid.getNormalizedBoneNode('head');
        if (head) {
          const headPos = new THREE.Vector3();
          const headQ = new THREE.Quaternion();
          head.getWorldPosition(headPos);
          head.getWorldQuaternion(headQ);
          const ear = headPos.add(new THREE.Vector3(-0.20, 0.02, 0.0).applyQuaternion(headQ));
          solvePhoneArm(ear);
        }
        if (phoneSequence.t > 0.7) {
          phoneSequence.phase = 'hold';
          window.dispatchEvent(new CustomEvent('audiencephone'));
        }
      } else if (phoneSequence.phase === 'hold') {
        const head = vrm.humanoid.getNormalizedBoneNode('head');
        if (head) {
          const headPos = new THREE.Vector3();
          const headQ = new THREE.Quaternion();
          head.getWorldPosition(headPos);
          head.getWorldQuaternion(headQ);
          const ear = headPos.add(new THREE.Vector3(-0.20, 0.02, 0.0).applyQuaternion(headQ));
          solvePhoneArm(ear);
        }
      } else if (phoneSequence.phase === 'leave') {
        const k = Math.min(1, phoneSequence.t / 0.75);
        const eased = 1 - Math.pow(1 - k, 3);
        group.position.lerpVectors(phoneSequence.from, phoneSequence.stand, eased);
        if (k >= 1) {
          phoneSequence.handset.visible = false;
          phoneSequence = null;
          movementLocked = false;
          externalWalking = false;
          applyWalking();
          window.dispatchEvent(new CustomEvent('audienceleft'));
        }
      }
    }

    if (phoneSequence && phoneSequence.mount) {
      const gripCurlQ = new THREE.Quaternion();
      for (const finger of rightFingerRig) {
        gripCurlQ.setFromAxisAngle(fingerCurlAxis, finger.curl * 1.12);
        finger.node.quaternion.copy(finger.rest).multiply(gripCurlQ).normalize();
      }
    }

    // Override the normalized arm pose *before* vrm.update so the humanoid
    // propagates it onto the raw skeleton used by the skinned meshes. Applying
    // it after vrm.update only changed normalized nodes and left the visible
    // arm following the walk swing.
    if (umbrellaMount && umbrellaVisual) {
      if (rightShoulderNode && restRightShoulder) rightShoulderNode.quaternion.copy(restRightShoulder);
      if (rightUpperArmNode) rightUpperArmNode.quaternion.copy(heldUpperArmQ);
      if (rightLowerArmNode) rightLowerArmNode.quaternion.copy(heldLowerArmQ);
      if (rightHandNode) rightHandNode.quaternion.copy(heldHandQ);
      for (const finger of rightFingerRig) {
        fingerCurlQ.setFromAxisAngle(fingerCurlAxis, finger.curl);
        finger.node.quaternion.copy(finger.rest).multiply(fingerCurlQ).normalize();
      }
    }

    if (wateringCanMount) {
      if (rightShoulderNode && restRightShoulder) rightShoulderNode.quaternion.copy(restRightShoulder);
      if (rightUpperArmNode) rightUpperArmNode.quaternion.copy(heldUpperArmQ);
      if (rightLowerArmNode) rightLowerArmNode.quaternion.copy(heldLowerArmQ);
      if (rightHandNode) rightHandNode.quaternion.copy(heldHandQ);
      for (const finger of rightFingerRig) {
        fingerCurlQ.setFromAxisAngle(fingerCurlAxis, finger.curl);
        finger.node.quaternion.copy(finger.rest).multiply(fingerCurlQ).normalize();
      }
    }

    vrm.update(dt);

    if (wateringCanMount && rightHandNode) {
      rightHandNode.getWorldQuaternion(wateringCanHandWorldQ);
      wateringCanMount.quaternion.copy(wateringCanHandWorldQ).invert();
      // Level the can against the hand first, then apply the audience-facing yaw.
      wateringCanYawQ.setFromAxisAngle(worldUp, group.rotation.y + Math.PI / 2);
      wateringCanMount.quaternion.multiply(wateringCanYawQ);
      // Roll the can body 20 degrees to the left while watering.
      if (wateringActive) {
        wateringRollQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(20));
        wateringCanMount.quaternion.multiply(wateringRollQ);
      }
    }

    if (umbrellaMount && umbrellaVisual) {
      vrm.scene.updateMatrixWorld(true);
      umbrellaMount.parent.updateWorldMatrix(true, false);
      umbrellaMount.parent.getWorldQuaternion(umbrellaHandWorldQuat);
      if (umbrellaShelterTarget) {
        umbrellaShelterDir.set(
          umbrellaShelterTarget.x - group.position.x,
          0,
          umbrellaShelterTarget.z - group.position.z
        );
        if (umbrellaShelterDir.lengthSq() < 0.0001) {
          umbrellaShelterDir.set(0, 0, 1);
        } else {
          umbrellaShelterDir.normalize();
        }
        const shelterAngle = Math.PI / 4;
        umbrellaTiltDir.set(0, 1, 0)
          .multiplyScalar(Math.cos(shelterAngle))
          .addScaledVector(umbrellaShelterDir, Math.sin(shelterAngle))
          .normalize();
        umbrellaTargetQuat.setFromUnitVectors(worldUp, umbrellaTiltDir);
      } else {
        umbrellaTiltEuler.set(0, group.rotation.y + 0.2, 0, 'YXZ');
        umbrellaTargetQuat.setFromEuler(umbrellaTiltEuler);
      }
      umbrellaMount.quaternion.copy(umbrellaHandWorldQuat).invert().multiply(umbrellaTargetQuat);

      // Place the handle at the tiger's mouth between thumb and index finger.
      const thumb = vrm.humanoid.getRawBoneNode('rightThumbProximal');
      const index = vrm.humanoid.getRawBoneNode('rightIndexProximal');
      if (thumb && index && umbrellaVisual) {
        thumb.getWorldPosition(thumbWorld);
        index.getWorldPosition(indexWorld);
        gripWorld.lerpVectors(thumbWorld, indexWorld, 0.5);
        umbrellaMount.getWorldPosition(mountWorldPos);
        umbrellaTargetInvQuat.copy(umbrellaTargetQuat).invert();
        gripLocal.copy(gripWorld).sub(mountWorldPos).applyQuaternion(umbrellaTargetInvQuat);
        // The handle center sits 0.18 * 1.4 above the umbrella group origin.
        gripLocal.y -= 0.252;
        umbrellaVisual.position.copy(gripLocal);
      }
    }

    if (walkAction) {
      walkAction.setEffectiveTimeScale(
        joystickMoving ? Math.max(0.25, moveInput.magnitude) * 1.5 : 1
      );
    }

    if (!movementLocked && joystickMoving && camera && moveInput.magnitude > 0) {
      camera.getWorldDirection(moveForward);
      moveForward.y = 0;
      if (moveForward.lengthSq() > 0.0001) {
        moveForward.normalize();
        moveRight.crossVectors(moveForward, worldUp).normalize();
        moveDirection.copy(moveForward).multiplyScalar(moveInput.y)
          .addScaledVector(moveRight, moveInput.x);
        if (moveDirection.lengthSq() > 0.0001) {
          moveDirection.normalize();
          const speed = WALK_SPEED * moveInput.magnitude;
          let nx = THREE.MathUtils.clamp(group.position.x + moveDirection.x * speed * dt, -OUTER_LIMIT, OUTER_LIMIT);
          let nz = THREE.MathUtils.clamp(group.position.z + moveDirection.z * speed * dt, -OUTER_LIMIT, OUTER_LIMIT);

          // Unlike the fence, the umbrella is a solid obstacle: keep pushing
          // in the same direction and the character stays put. Only a new
          // movement direction that clears the box can get around it.
          if (fenceCollisionEnabled && insideFence(nx, nz)) {
            if (!insideFence(nx, group.position.z)) {
              nz = group.position.z;
            } else if (!insideFence(group.position.x, nz)) {
              nx = group.position.x;
            } else {
              nx = group.position.x;
              nz = group.position.z;
            }
          }
          if (hitsObstacle(nx, nz)) {
            // Slide along obstacle edges instead of cancelling both axes.
            // This keeps brick paths and narrow passages walkable when a
            // collider only clips one side of the character.
            if (!hitsObstacle(nx, group.position.z)) {
              nz = group.position.z;
            } else if (!hitsObstacle(group.position.x, nz)) {
              nx = group.position.x;
            } else {
              nx = group.position.x;
              nz = group.position.z;
            }
          }
          group.position.x = nx;
          group.position.z = nz;

          const targetYaw = Math.atan2(moveDirection.x, moveDirection.z);
          let yawDelta = targetYaw - group.rotation.y;
          yawDelta = Math.atan2(Math.sin(yawDelta), Math.cos(yawDelta));
          group.rotation.y += yawDelta * (1 - Math.exp(-dt * 12));
        }
      }
    }

    if (onStep && walking && walkAction && walkDuration > 0) {
      const stepIndex = Math.floor((walkAction.time / walkDuration) * 2);
      if (stepIndex !== lastFootstepIndex) {
        lastFootstepIndex = stepIndex;
        const footName = stepIndex % 2 === 0 ? 'rightFoot' : 'leftFoot';
        const footNode = vrm.humanoid.getNormalizedBoneNode(footName);
        if (footNode) {
          footNode.getWorldPosition(footstepWorld);
          onStep({ x: footstepWorld.x, z: footstepWorld.z, foot: footName });
        }
      }
    } else if (!walking) {
      lastFootstepIndex = -1;
    }

    if (vrm.scene) vrm.scene.position.y = baseSceneY + fenceStepLift;
  };

  (async () => {
    try {
      const [vrmBuffer, walkBuffer] = await Promise.all([
        getBuffer(VRM_URL, '__AUDIENCE_VRM_BASE64__'),
        getBuffer(WALK_URL, '__WALKING_GLB_BASE64__'),
      ]);

      const vrmLoader = new GLTFLoader();
      vrmLoader.register((parser) => new VRMLoaderPlugin(parser));
      const [vrmGltf, walkGltf] = await Promise.all([
        parseGLTF(vrmLoader, vrmBuffer),
        parseGLTF(new GLTFLoader(), walkBuffer),
      ]);
      if (disposed) return;

      vrm = vrmGltf.userData.vrm;
      if (!vrm) throw new Error('VRM data missing from VRM loader.');

      vrm.scene.traverse((object) => {
        if (object.isMesh || object.isSkinnedMesh) object.frustumCulled = false;
      });
      vrm.scene.removeFromParent();
      group.add(vrm.scene);
      applyEnvironmentTone(vrm);

      vrm.scene.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(vrm.scene);
      const height = bounds.max.y - bounds.min.y;
      if (height > 0.001) {
        const scale = TARGET_HEIGHT / height;
        vrm.scene.scale.multiplyScalar(scale);
        vrm.scene.updateMatrixWorld(true);
        const scaledBounds = new THREE.Box3().setFromObject(vrm.scene);
        vrm.scene.position.y -= scaledBounds.min.y;
      }
      baseSceneY = vrm.scene.position.y;

      vrm.humanoid.resetNormalizedPose();
      rightShoulderNode = vrm.humanoid.getNormalizedBoneNode('rightShoulder');
      rightUpperArmNode = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      rightLowerArmNode = vrm.humanoid.getNormalizedBoneNode('rightLowerArm');
      rightHandNode = vrm.humanoid.getNormalizedBoneNode('rightHand');
      restRightShoulder = rightShoulderNode?.quaternion.clone() ?? null;
      restRightLowerArm = rightLowerArmNode?.quaternion.clone() ?? null;
      restRightHand = rightHandNode?.quaternion.clone() ?? null;
      const fingerNames = [
        ['rightThumbMetacarpal', 0.25],
        ['rightThumbProximal', 0.5],
        ['rightThumbDistal', 0.4],
        ['rightIndexProximal', 0.85],
        ['rightIndexIntermediate', 1.05],
        ['rightIndexDistal', 0.85],
        ['rightMiddleProximal', 0.95],
        ['rightMiddleIntermediate', 1.15],
        ['rightMiddleDistal', 0.9],
        ['rightRingProximal', 1.0],
        ['rightRingIntermediate', 1.2],
        ['rightRingDistal', 0.95],
        ['rightLittleProximal', 1.05],
        ['rightLittleIntermediate', 1.25],
        ['rightLittleDistal', 1.0],
      ];
      rightFingerRig.length = 0;
      for (const [name, curl] of fingerNames) {
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) rightFingerRig.push({ node, rest: node.quaternion.clone(), curl });
      }
      const { idleClip, walkClip } = buildRetargetedClips(vrm, walkGltf);
      walkDuration = Math.max(walkClip.duration, 0.001);

      mixer = new THREE.AnimationMixer(vrm.scene);
      idleAction = mixer.clipAction(idleClip);
      walkAction = mixer.clipAction(walkClip);
      idleAction.setLoop(THREE.LoopRepeat, Infinity);
      walkAction.setLoop(THREE.LoopRepeat, Infinity);
      idleAction.play();
      walking = false;

      if (externalWalking || joystickMoving) applyWalking();
      onReady?.(group);
    } catch (error) {
      console.error('Audience load failed:', error);
      onError?.(error);
    }
  })();

  group.userData.dispose = () => {
    disposed = true;
    if (mixer) mixer.stopAllAction();
  };

  return group;
}
