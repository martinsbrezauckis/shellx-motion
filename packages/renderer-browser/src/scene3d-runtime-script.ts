/** Motion-owned WebGL host: packages provide bounded data, never code, shaders, URLs, or textures. */
export function fixedScene3DRuntimeScript(): string {
  return `<script data-shellx-motion-scene3d-runtime="true">(() => {
const vertexSource = [
  "attribute vec3 a_position;",
  "attribute vec3 a_normal;",
  "uniform mat4 u_mvp;",
  "uniform mat4 u_model;",
  "varying vec3 v_normal;",
  "void main(){gl_Position=u_mvp*vec4(a_position,1.0);v_normal=normalize((u_model*vec4(a_normal,0.0)).xyz);}",
].join("");
const fragmentSource = [
  "precision highp float;",
  "varying vec3 v_normal;",
  "uniform vec3 u_color;",
  "uniform vec3 u_light_direction;",
  "uniform vec3 u_light_color;",
  "uniform float u_ambient;",
  "uniform float u_intensity;",
  "uniform float u_emissive;",
  "void main(){float d=max(dot(normalize(v_normal),normalize(-u_light_direction)),0.0);",
  "vec3 c=u_color*(u_ambient+u_emissive+d*u_intensity)*u_light_color;gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}",
].join("");
const decode = (value) => JSON.parse(atob(value || ""));
const compile = (gl, type, source) => {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not allocate a fixed scene shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error((gl.getShaderInfoLog(shader) || "Fixed scene shader compilation failed.").slice(0, 512));
  }
  return shader;
};
const multiply = (a, b) => {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
};
const identity = () => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const translation = (v) => { const out=identity(); out[12]=v[0]; out[13]=v[1]; out[14]=v[2]; return out; };
const scaling = (value) => new Float32Array([value,0,0,0, 0,value,0,0, 0,0,value,0, 0,0,0,1]);
const rotationX = (r) => { const c=Math.cos(r),s=Math.sin(r); return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]); };
const rotationY = (r) => { const c=Math.cos(r),s=Math.sin(r); return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]); };
const rotationZ = (r) => { const c=Math.cos(r),s=Math.sin(r); return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]); };
const normalize = (v) => { const length=Math.hypot(v[0],v[1],v[2])||1; return [v[0]/length,v[1]/length,v[2]/length]; };
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const lookAt = (eye,target) => {
  const z=normalize([eye[0]-target[0],eye[1]-target[1],eye[2]-target[2]]);
  const x=normalize(cross([0,1,0],z)),y=cross(z,x),out=identity();
  out[0]=x[0];out[1]=y[0];out[2]=z[0];out[4]=x[1];out[5]=y[1];out[6]=z[1];
  out[8]=x[2];out[9]=y[2];out[10]=z[2];out[12]=-dot(x,eye);out[13]=-dot(y,eye);out[14]=-dot(z,eye);
  return out;
};
const perspective = (fov,aspect,near,far) => {
  const f=1/Math.tan(fov/2),nf=1/(near-far),out=new Float32Array(16);
  out[0]=f/aspect;out[5]=f;out[10]=(far+near)*nf;out[11]=-1;out[14]=2*far*near*nf;
  return out;
};
const hex = (value) => [
  parseInt(value.slice(1,3),16)/255,
  parseInt(value.slice(3,5),16)/255,
  parseInt(value.slice(5,7),16)/255,
];
const fixedGeometry = (primitive) => {
  const positions=[],normals=[];
  const tri=(a,b,c,n)=>{positions.push(...a,...b,...c);normals.push(...n,...n,...n);};
  const quad=(a,b,c,d,n)=>{tri(a,b,c,n);tri(a,c,d,n);};
  if(primitive==="plane") quad([-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5],[0,1,0]);
  else if(primitive==="pyramid") {
    const a=[-.5,-.5,-.5],b=[.5,-.5,-.5],c=[.5,-.5,.5],d=[-.5,-.5,.5],top=[0,.65,0];
    quad(a,d,c,b,[0,-1,0]);
    const face=(left,right)=>{
      const u=[right[0]-left[0],right[1]-left[1],right[2]-left[2]];
      const v=[top[0]-left[0],top[1]-left[1],top[2]-left[2]];
      tri(left,right,top,normalize(cross(u,v)));
    };
    face(a,b);face(b,c);face(c,d);face(d,a);
  } else {
    const n=-.5,p=.5;
    quad([n,n,p],[p,n,p],[p,p,p],[n,p,p],[0,0,1]);quad([p,n,n],[n,n,n],[n,p,n],[p,p,n],[0,0,-1]);
    quad([n,p,p],[p,p,p],[p,p,n],[n,p,n],[0,1,0]);quad([n,n,n],[p,n,n],[p,n,p],[n,n,p],[0,-1,0]);
    quad([p,n,p],[p,n,n],[p,p,n],[p,p,p],[1,0,0]);quad([n,n,n],[n,n,p],[n,p,p],[n,p,n],[-1,0,0]);
  }
  return {positions,normals,indices:null};
};
const geometry = (object) => object.primitive === "mesh" ? object.geometry : fixedGeometry(object.primitive);
for (const canvas of document.querySelectorAll("canvas[data-motion-scene3d='true']")) {
  try {
    const config=decode(canvas.dataset.motionScene3dConfig),time=Number(canvas.dataset.motionScene3dTime||0);
    const gl=canvas.getContext("webgl",{
      alpha:true,antialias:true,depth:true,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:true,powerPreference:"low-power",
    });
    if(!gl) throw new Error("Deterministic WebGL is unavailable.");
    const program=gl.createProgram();
    if(!program) throw new Error("WebGL could not allocate a fixed scene program.");
    gl.attachShader(program,compile(gl,gl.VERTEX_SHADER,vertexSource));
    gl.attachShader(program,compile(gl,gl.FRAGMENT_SHADER,fragmentSource));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) {
      throw new Error((gl.getProgramInfoLog(program)||"Fixed scene link failed.").slice(0,512));
    }
    gl.useProgram(program);
    const locations={
      position:gl.getAttribLocation(program,"a_position"),normal:gl.getAttribLocation(program,"a_normal"),
      mvp:gl.getUniformLocation(program,"u_mvp"),model:gl.getUniformLocation(program,"u_model"),
      color:gl.getUniformLocation(program,"u_color"),lightDirection:gl.getUniformLocation(program,"u_light_direction"),
      lightColor:gl.getUniformLocation(program,"u_light_color"),ambient:gl.getUniformLocation(program,"u_ambient"),
      intensity:gl.getUniformLocation(program,"u_intensity"),emissive:gl.getUniformLocation(program,"u_emissive"),
    };
    const orbit=(config.camera.orbitDegPerSecond||0)*time*Math.PI/180,base=config.camera.position,target=config.camera.target;
    const dx=base[0]-target[0],dz=base[2]-target[2];
    const eye=[target[0]+dx*Math.cos(orbit)+dz*Math.sin(orbit),base[1],target[2]-dx*Math.sin(orbit)+dz*Math.cos(orbit)];
    const projection=perspective(config.camera.fovDeg*Math.PI/180,canvas.width/canvas.height,config.camera.near,config.camera.far);
    const viewProjection=multiply(projection,lookAt(eye,target)),clear=hex(config.backgroundColor);
    gl.viewport(0,0,canvas.width,canvas.height);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);
    gl.clearColor(clear[0],clear[1],clear[2],1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const light=hex(config.lighting.color),cache=new Map();
    gl.uniform3fv(locations.lightDirection,new Float32Array(config.lighting.direction));
    gl.uniform3fv(locations.lightColor,new Float32Array(light));
    gl.uniform1f(locations.ambient,config.lighting.ambient);gl.uniform1f(locations.intensity,config.lighting.intensity);
    for(const object of config.objects) {
      const key=object.primitive==="mesh"?object.id:object.primitive;
      let buffers=cache.get(key);
      if(!buffers) {
        const data=geometry(object),position=gl.createBuffer(),normal=gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER,position);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data.positions),gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER,normal);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(data.normals),gl.STATIC_DRAW);
        let index=null;
        if(data.indices){
          index=gl.createBuffer();
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,index);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(data.indices),gl.STATIC_DRAW);
        }
        buffers={position,normal,index,count:data.indices?data.indices.length:data.positions.length/3};cache.set(key,buffers);
      }
      const degrees=object.rotationDeg.map((value,index)=>value+object.spinDegPerSecond[index]*time);
      const r=degrees.map(value=>value*Math.PI/180);
      let model=multiply(translation(object.position),rotationZ(r[2]));
      model=multiply(model,rotationY(r[1]));model=multiply(model,rotationX(r[0]));model=multiply(model,scaling(object.scale));
      gl.uniformMatrix4fv(locations.mvp,false,multiply(viewProjection,model));gl.uniformMatrix4fv(locations.model,false,model);
      gl.uniform3fv(locations.color,new Float32Array(hex(object.color)));gl.uniform1f(locations.emissive,object.emissive);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffers.position);gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position,3,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,buffers.normal);
      gl.enableVertexAttribArray(locations.normal);gl.vertexAttribPointer(locations.normal,3,gl.FLOAT,false,0,0);
      if(buffers.index){gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffers.index);gl.drawElements(gl.TRIANGLES,buffers.count,gl.UNSIGNED_SHORT,0);}
      else gl.drawArrays(gl.TRIANGLES,0,buffers.count);
    }
    gl.finish();canvas.dataset.motionScene3dState="ready";
  } catch(error) {
    canvas.dataset.motionScene3dState="error";
    canvas.dataset.motionScene3dError=String(error instanceof Error?error.message:error).slice(0,512);
  }
}
})();</script>`;
}
