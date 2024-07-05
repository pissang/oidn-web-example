import {
  ACESFilmicToneMapping,
  CustomBlending,
  Scene,
  Box3,
  Mesh,
  CylinderGeometry,
  MeshPhysicalMaterial,
  WebGLRenderer,
  EquirectangularReflectionMapping,
  PerspectiveCamera,
  Color,
  MeshBasicMaterial,
  Texture,
  CanvasTexture
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

import { initUNetFromURL } from 'oidn-web';

const ENV_URL =
  'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/autoshop_01_1k.hdr';
const MODEL_URL =
  'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/main/models/material-balls/material_ball_v2.glb';
const TZA_URL = './rt_ldr.tza';

let pathTracer, renderer, controls, shellMaterial;
let camera, scene;
let unet;
let denoiseCanvas, abortDenoise;

const params = {
  materialProperties: {
    color: '#ffe6bd',
    emissive: '#000000',
    emissiveIntensity: 1,
    roughness: 0,
    metalness: 1,
    ior: 1.495,
    transmission: 0.0,
    thinFilm: false,
    attenuationColor: '#ffffff',
    attenuationDistance: 0.5,
    opacity: 1.0,
    clearcoat: 0.0,
    clearcoatRoughness: 0.0,
    sheenColor: '#000000',
    sheenRoughness: 0.0,
    iridescence: 0.0,
    iridescenceIOR: 1.5,
    iridescenceThickness: 400,
    specularColor: '#ffffff',
    specularIntensity: 1.0,
    matte: false,
    flatShading: false,
    castShadow: true
  },

  multipleImportanceSampling: true,
  denoiseEnabled: true,
  denoiseSigma: 2.5,
  denoiseThreshold: 0.1,
  denoiseKSigma: 1.0,
  bounces: 5,
  renderScale: 1,
  transmissiveBounces: 20,
  filterGlossyFactor: 0.5,
  tiles: 1
};

if (window.location.hash.includes('transmission')) {
  params.materialProperties.metalness = 0.0;
  params.materialProperties.roughness = 0.23;
  params.materialProperties.transmission = 1.0;
  params.materialProperties.color = '#ffffff';

  params.bounces = 10;
  params.tiles = 2;
} else if (window.location.hash.includes('iridescent')) {
  params.materialProperties.color = '#474747';
  params.materialProperties.roughness = 0.25;
  params.materialProperties.metalness = 1.0;
  params.materialProperties.iridescence = 1.0;
  params.materialProperties.iridescenceIOR = 2.2;
} else if (window.location.hash.includes('acrylic')) {
  params.materialProperties.color = '#ffffff';
  params.materialProperties.roughness = 0;
  params.materialProperties.metalness = 0;
  params.materialProperties.transmission = 1.0;
  params.materialProperties.attenuationDistance = 0.75;
  params.materialProperties.attenuationColor = '#2a6dc6';

  params.bounces = 20;
  params.tiles = 3;
}

// adjust performance parameters for mobile
const aspectRatio = window.innerWidth / window.innerHeight;
if (aspectRatio < 0.65) {
  params.bounces = Math.max(params.bounces, 6);
  // params.renderScale *= 0.5;
  params.tiles = 2;
  params.multipleImportanceSampling = false;
}

init();

async function init() {
  // renderer
  renderer = new WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true
  });
  renderer.toneMapping = ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  // path tracer
  pathTracer = new WebGLPathTracer(renderer);
  pathTracer.tiles.set(params.tiles, params.tiles);

  // camera
  const aspect = window.innerWidth / window.innerHeight;
  camera = new PerspectiveCamera(75, aspect, 0.025, 500);
  camera.position.set(-4, 2, 5);

  // controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.addEventListener('change', () => pathTracer.updateCamera());

  scene = new Scene();
  scene.backgroundBlurriness = 0.05;

  // load assets
  const [envTexture, gltf, _unet] = await Promise.all([
    new RGBELoader().loadAsync(ENV_URL),
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(MODEL_URL),
    initUNetFromURL(TZA_URL)
  ]);
  unet = _unet;

  // set environment
  envTexture.mapping = EquirectangularReflectionMapping;
  scene.background = envTexture;
  scene.environment = envTexture;

  // set up scene
  gltf.scene.scale.setScalar(0.01);
  gltf.scene.updateMatrixWorld();
  scene.add(gltf.scene);

  const box = new Box3();
  box.setFromObject(gltf.scene);

  const floor = new Mesh(
    new CylinderGeometry(3, 3, 0.05, 200),
    new MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.1,
      metalness: 0.9
    })
  );
  floor.geometry = floor.geometry.toNonIndexed();
  floor.geometry.clearGroups();
  floor.position.y = box.min.y - 0.03;
  scene.add(floor);

  const coreMaterial = new MeshPhysicalMaterial({
    color: new Color(0.5, 0.5, 0.5)
  });
  shellMaterial = new MeshPhysicalMaterial();

  gltf.scene.traverse((c) => {
    // the vertex normals on the material ball are off...
    // TODO: precompute the vertex normals so they are correct on load
    if (c.geometry) {
      c.geometry.computeVertexNormals();
    }

    if (c.name === 'Sphere_1') {
      c.material = coreMaterial;
    } else {
      c.material = shellMaterial;
    }

    if (c.name === 'subsphere_1') {
      c.material = coreMaterial;
    }
  });

  onParamsChange();
  onResize();
  window.addEventListener('resize', onResize);

  // gui
  const gui = new GUI();
  const ptFolder = gui.addFolder('Path Tracer');
  ptFolder.add(params, 'multipleImportanceSampling').onChange(onParamsChange);
  ptFolder.add(params, 'tiles', 1, 4, 1).onChange((value) => {
    pathTracer.tiles.set(value, value);
  });
  ptFolder.add(params, 'filterGlossyFactor', 0, 1).onChange(onParamsChange);
  ptFolder.add(params, 'bounces', 1, 30, 1).onChange(onParamsChange);
  ptFolder
    .add(params, 'transmissiveBounces', 0, 40, 1)
    .onChange(onParamsChange);
  ptFolder.add(params, 'renderScale', 0.1, 1).onChange(onParamsChange);

  const matFolder1 = gui.addFolder('Material');
  matFolder1
    .addColor(params.materialProperties, 'color')
    .onChange(onParamsChange);
  matFolder1
    .addColor(params.materialProperties, 'emissive')
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'emissiveIntensity', 0.0, 50.0, 0.01)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'roughness', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'metalness', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'opacity', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'transmission', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'thinFilm', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'attenuationDistance', 0.05, 2.0)
    .onChange(onParamsChange);
  matFolder1
    .addColor(params.materialProperties, 'attenuationColor')
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'ior', 0.9, 3.0)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'clearcoat', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'clearcoatRoughness', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .addColor(params.materialProperties, 'sheenColor')
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'sheenRoughness', 0, 1)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'iridescence', 0.0, 1.0)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'iridescenceIOR', 0.1, 3.0)
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'iridescenceThickness', 0.0, 1200.0)
    .onChange(onParamsChange);
  matFolder1
    .addColor(params.materialProperties, 'specularColor')
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'specularIntensity', 0.0, 1.0)
    .onChange(onParamsChange);
  matFolder1.add(params.materialProperties, 'matte').onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'flatShading')
    .onChange(onParamsChange);
  matFolder1
    .add(params.materialProperties, 'castShadow')
    .onChange(onParamsChange);
  matFolder1.close();

  animate();
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = 30;
  camera.updateProjectionMatrix();
  pathTracer.updateCamera();
}

function onParamsChange() {
  const materialProperties = params.materialProperties;
  shellMaterial.color.set(materialProperties.color);
  shellMaterial.emissive.set(materialProperties.emissive);
  shellMaterial.emissiveIntensity = materialProperties.emissiveIntensity;
  shellMaterial.metalness = materialProperties.metalness;
  shellMaterial.roughness = materialProperties.roughness;
  shellMaterial.transmission = materialProperties.transmission;
  shellMaterial.attenuationDistance = materialProperties.thinFilm
    ? Infinity
    : materialProperties.attenuationDistance;
  shellMaterial.attenuationColor.set(materialProperties.attenuationColor);
  shellMaterial.ior = materialProperties.ior;
  shellMaterial.opacity = materialProperties.opacity;
  shellMaterial.clearcoat = materialProperties.clearcoat;
  shellMaterial.clearcoatRoughness = materialProperties.clearcoatRoughness;
  shellMaterial.sheenColor.set(materialProperties.sheenColor);
  shellMaterial.sheenRoughness = materialProperties.sheenRoughness;
  shellMaterial.iridescence = materialProperties.iridescence;
  shellMaterial.iridescenceIOR = materialProperties.iridescenceIOR;
  shellMaterial.iridescenceThicknessRange = [
    0,
    materialProperties.iridescenceThickness
  ];
  shellMaterial.specularColor.set(materialProperties.specularColor);
  shellMaterial.specularIntensity = materialProperties.specularIntensity;
  shellMaterial.transparent = shellMaterial.opacity < 1;
  shellMaterial.flatShading = materialProperties.flatShading;

  pathTracer.transmissiveBounces = params.transmissiveBounces;
  pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
  pathTracer.filterGlossyFactor = params.filterGlossyFactor;
  pathTracer.bounces = params.bounces;
  pathTracer.renderScale = params.renderScale;

  // note: custom properties
  shellMaterial.matte = materialProperties.matte;
  shellMaterial.castShadow = materialProperties.castShadow;

  pathTracer.updateMaterials();
  pathTracer.setScene(scene, camera);
}

function denoise() {
  if (!denoiseCanvas) {
    denoiseCanvas = document.createElement('canvas');
    denoiseCanvas.willReadFrequently = true;
    document.body.appendChild(denoiseCanvas);
    denoiseCanvas.style.cssText =
      'position:absolute; left: 0; top: 0; z-index: 1; pointer-events: none;';
  }
  const ctx = denoiseCanvas.getContext('2d');
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  denoiseCanvas.width = w;
  denoiseCanvas.height = h;
  ctx.willReadFrequently;
  ctx.drawImage(renderer.domElement, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  abortDenoise = unet.tileExecute({
    color: imageData,
    done() {},
    progress: (_, tileData, tile) => {
      ctx.putImageData(tileData, tile.x, tile.y);
    }
  });
}

function animate() {
  requestAnimationFrame(animate);

  if (pathTracer.samples < 20) {
    if (abortDenoise) {
      denoiseCanvas
        .getContext('2d')
        .clearRect(0, 0, denoiseCanvas.width, denoiseCanvas.height);
    }
    abortDenoise?.();
    abortDenoise = undefined;
    pathTracer.renderSample();
  } else {
    // Denoising
    if (!abortDenoise) {
      denoise();
    }
  }
}
