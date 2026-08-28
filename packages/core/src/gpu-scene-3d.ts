import type { GpuScene3dIntent } from "./gpu-frame-intent";
import { parseGpuSceneColor } from "./gpu-scene-color";
import { gpuSceneEffects } from "./gpu-scene-effects";
import { scene3dMeshGeometrySha256 } from "./scene-3d-geometry";
import { validateScene3DLayers } from "./scene-3d-validate";
import type { MotionLayer, MotionScene3DObject, MotionVec3 } from "./types";

export type GpuScene3dCompileResult = { ok: true; draw: GpuScene3dIntent } | { ok: false; message: string };

/** Lowers one validated fixed-data scene to matrices and bounded GPU buffers. */
export function compileGpuScene3d(layer: MotionLayer, atMs: number, frameWidth: number, frameHeight: number): GpuScene3dCompileResult {
  const errors: Array<{ path: string; message: string }> = [];
  validateScene3DLayers([layer], errors);
  if (errors.length > 0 || !layer.scene3d) return { ok: false, message: `GPU scene3d is invalid${errors[0] ? ` at ${errors[0].path}: ${errors[0].message}` : ""}.` };
  const scene = layer.scene3d;
  const background = parseGpuSceneColor(scene.backgroundColor); const lightColor = parseGpuSceneColor(scene.lighting.color);
  if (!background || !lightColor) return { ok: false, message: "GPU scene3d colors must be hexadecimal." };
  const opacity = finiteUnit(layer.transform?.opacity ?? layer.opacity ?? 1);
  if (opacity === null) return { ok: false, message: `GPU scene3d layer ${layer.id} has invalid opacity.` };
  const seconds = Math.max(0, atMs - layer.startMs) / 1_000;
  const cameraPosition = orbitCamera(scene.camera.position, scene.camera.target, (scene.camera.orbitDegPerSecond ?? 0) * seconds);
  const viewProjection = multiply(
    perspective(scene.camera.fovDeg * Math.PI / 180, frameWidth / frameHeight, scene.camera.near, scene.camera.far),
    lookAt(cameraPosition, scene.camera.target),
  );
  const objects: GpuScene3dIntent["objects"] = [];
  for (const object of scene.objects) {
    const compiled = compileObject(object, seconds, opacity);
    if (!compiled.ok) return { ok: false, message: compiled.message };
    objects.push(compiled.object);
  }
  return { ok: true, draw: {
    kind: "scene3d", id: layer.id, blendMode: layer.blendMode ?? "normal", effects: gpuSceneEffects(layer),
    background: { ...background, a: opacity }, opacity, viewProjection,
    lightDirection: [...scene.lighting.direction], lightColor,
    ambient: scene.lighting.ambient, intensity: scene.lighting.intensity, objects,
  } };
}

function compileObject(object: MotionScene3DObject, seconds: number, opacity: number): { ok: true; object: GpuScene3dIntent["objects"][number] } | { ok: false; message: string } {
  const geometry = object.primitive === "mesh" ? meshGeometry(object) : { ok: true as const, geometry: fixedGeometry(object.primitive) };
  if (!geometry.ok) return geometry;
  const spin = object.spinDegPerSecond ?? [0, 0, 0];
  const rotation: MotionVec3 = [
    object.rotationDeg[0] + spin[0] * seconds,
    object.rotationDeg[1] + spin[1] * seconds,
    object.rotationDeg[2] + spin[2] * seconds,
  ];
  const color = parseGpuSceneColor(object.color);
  if (!color) throw new Error(`GPU scene3d object ${object.id} color is invalid after validation.`);
  const model = multiply(translation(object.position), multiply(rotationZ(rad(rotation[2])), multiply(rotationY(rad(rotation[1])), multiply(rotationX(rad(rotation[0])), scaling(object.scale)))));
  return { ok: true, object: { id: object.id, ...geometry.geometry, model, color: { ...color, a: opacity }, emissive: object.emissive ?? 0 } };
}

function meshGeometry(object: Extract<MotionScene3DObject, { primitive: "mesh" }>): { ok: true; geometry: { vertices: number[]; indices: number[] } } | { ok: false; message: string } {
  if (scene3dMeshGeometrySha256(object.geometry) !== object.source.geometrySha256) {
    return { ok: false, message: `GPU scene3d mesh ${object.id} geometry does not match its glTF source hash.` };
  }
  const vertices: number[] = [];
  for (let index = 0; index < object.geometry.positions.length; index += 3) vertices.push(
    object.geometry.positions[index], object.geometry.positions[index + 1], object.geometry.positions[index + 2],
    object.geometry.normals[index], object.geometry.normals[index + 1], object.geometry.normals[index + 2],
  );
  return { ok: true, geometry: { vertices, indices: [...object.geometry.indices] } };
}

function fixedGeometry(primitive: "box" | "pyramid" | "plane"): { vertices: number[]; indices: number[] } {
  const vertices: number[] = []; const indices: number[] = [];
  const triangle = (a: MotionVec3, b: MotionVec3, c: MotionVec3, normal: MotionVec3): void => {
    const offset = vertices.length / 6; vertices.push(...a, ...normal, ...b, ...normal, ...c, ...normal); indices.push(offset, offset + 1, offset + 2);
  };
  const quad = (a: MotionVec3, b: MotionVec3, c: MotionVec3, d: MotionVec3, normal: MotionVec3): void => { triangle(a, b, c, normal); triangle(a, c, d, normal); };
  if (primitive === "plane") quad([-.5, 0, -.5], [.5, 0, -.5], [.5, 0, .5], [-.5, 0, .5], [0, 1, 0]);
  else if (primitive === "pyramid") {
    const a:MotionVec3=[-.5,-.5,-.5],b:MotionVec3=[.5,-.5,-.5],c:MotionVec3=[.5,-.5,.5],d:MotionVec3=[-.5,-.5,.5],top:MotionVec3=[0,.65,0];
    quad(a,d,c,b,[0,-1,0]); const face=(left:MotionVec3,right:MotionVec3):void=>triangle(left,right,top,normalize(cross(subtract(right,left),subtract(top,left)))); face(a,b);face(b,c);face(c,d);face(d,a);
  } else {
    const n=-.5,p=.5;
    quad([n,n,p],[p,n,p],[p,p,p],[n,p,p],[0,0,1]);quad([p,n,n],[n,n,n],[n,p,n],[p,p,n],[0,0,-1]);quad([n,p,p],[p,p,p],[p,p,n],[n,p,n],[0,1,0]);quad([n,n,n],[p,n,n],[p,n,p],[n,n,p],[0,-1,0]);quad([p,n,p],[p,n,n],[p,p,n],[p,p,p],[1,0,0]);quad([n,n,n],[n,n,p],[n,p,p],[n,p,n],[-1,0,0]);
  }
  return { vertices, indices };
}

function orbitCamera(position: MotionVec3, target: MotionVec3, degrees: number): MotionVec3 { const angle=rad(degrees),x=position[0]-target[0],z=position[2]-target[2];return[target[0]+x*Math.cos(angle)+z*Math.sin(angle),position[1],target[2]-x*Math.sin(angle)+z*Math.cos(angle)]; }
function identity():number[]{return[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
function multiply(a:number[],b:number[]):number[]{const out=new Array<number>(16).fill(0);for(let column=0;column<4;column+=1)for(let row=0;row<4;row+=1)for(let k=0;k<4;k+=1)out[column*4+row]+=a[k*4+row]*b[column*4+k];return out;}
function translation(v:MotionVec3):number[]{const out=identity();out[12]=v[0];out[13]=v[1];out[14]=v[2];return out;}
function scaling(value:number):number[]{return[value,0,0,0,0,value,0,0,0,0,value,0,0,0,0,1];}
function rotationX(r:number):number[]{const c=Math.cos(r),s=Math.sin(r);return[1,0,0,0,0,c,s,0,0,-s,c,0,0,0,0,1];}
function rotationY(r:number):number[]{const c=Math.cos(r),s=Math.sin(r);return[c,0,-s,0,0,1,0,0,s,0,c,0,0,0,0,1];}
function rotationZ(r:number):number[]{const c=Math.cos(r),s=Math.sin(r);return[c,s,0,0,-s,c,0,0,0,0,1,0,0,0,0,1];}
function perspective(fov:number,aspect:number,near:number,far:number):number[]{const f=1/Math.tan(fov/2),nf=1/(near-far),out=new Array<number>(16).fill(0);out[0]=f/aspect;out[5]=f;out[10]=(far+near)*nf;out[11]=-1;out[14]=2*far*near*nf;return out;}
function lookAt(eye:MotionVec3,target:MotionVec3):number[]{const z=normalize(subtract(eye,target)),x=normalize(cross([0,1,0],z)),y=cross(z,x),out=identity();out[0]=x[0];out[1]=y[0];out[2]=z[0];out[4]=x[1];out[5]=y[1];out[6]=z[1];out[8]=x[2];out[9]=y[2];out[10]=z[2];out[12]=-dot(x,eye);out[13]=-dot(y,eye);out[14]=-dot(z,eye);return out;}
function subtract(a:MotionVec3,b:MotionVec3):MotionVec3{return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
function cross(a:MotionVec3,b:MotionVec3):MotionVec3{return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function dot(a:MotionVec3,b:MotionVec3):number{return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function normalize(v:MotionVec3):MotionVec3{const length=Math.hypot(...v)||1;return[v[0]/length,v[1]/length,v[2]/length];}
function rad(degrees:number):number{return degrees*Math.PI/180;}
function finiteUnit(value:unknown):number|null{return typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1?value:null;}
