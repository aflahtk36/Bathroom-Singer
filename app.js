'use strict';
const $=id=>document.getElementById(id);
const S=256,R=64,LEAD=2,PX=.05,LV={easy:[120,.3,.5],normal:[70,.2,.7],hard:[40,.12,1]};
const SONG={bpm:96,buf:null},N=[];
let hasImage=false;

// ---------- built-in song: Twinkle Twinkle (public domain). midi:beats, "|" ends a phrase ----------
const MEL="60:1 60:1 67:1 67:1 69:1 69:1 67:2|65:1 65:1 64:1 64:1 62:1 62:1 60:2|67:1 67:1 65:1 65:1 64:1 64:1 62:2|67:1 67:1 65:1 65:1 64:1 64:1 62:2|60:1 60:1 67:1 67:1 69:1 69:1 67:2|65:1 65:1 64:1 64:1 62:1 62:1 60:2";
const CH="C C F C F C G C C F C G C F C G C C F C F C G C";
const CHORD={C:[48,52,55],F:[53,57,60],G:[55,59,62]};
{const b=60/SONG.bpm;let t=LEAD;MEL.split("|").forEach((p,i)=>p.split(" ").forEach(x=>{const[m,d]=x.split(":").map(Number);N.push({start:t,end:t+d*b*.9,midi:m,phrase:i,score:0});t+=d*b}))}

const hz=m=>440*2**((m-69)/12), cents=(f,m)=>1200*Math.log2(f/hz(m)), fold=c=>((c+600)%1200+1200)%1200-600;
const NAMES=["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"], name=m=>NAMES[m%12]+(Math.floor(m/12)-1);
const near=(t,s)=>{let b=null,bd=1e9;for(const n of N){const d=t<n.start?n.start-t:t>n.end?t-n.end:0;if(d<=s&&d<bd){b=n;bd=d}}return b};

// ---------- the picture (a default one, or your own) ----------
const src=document.createElement("canvas");src.width=src.height=S;
$("pic").onchange=e=>{const f=e.target.files[0];if(!f)return;const im=new Image();
im.onload=()=>{const k=Math.min(im.width,im.height),g=src.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,S,S);g.drawImage(im,(im.width-k)/2,(im.height-k)/2,k,k,0,0,S,S);
hasImage=true;$("empty").style.display="none";$("fileName").textContent=f.name;prep();drawFreq(running?ctx.currentTime-T0:-1)};
im.src=URL.createObjectURL(f)};

// ---------- frequency reconstruction (2-D Fourier transform, computed with the FFT) ----------
// in-place radix-2 FFT of one row or column; inv=true runs the inverse transform
function fft(re,im,inv){const n=re.length;
for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t}}
for(let len=2;len<=n;len<<=1){const a=(inv?2:-2)*Math.PI/len;
for(let i=0;i<n;i+=len)for(let k=0;k<len/2;k++){const wr=Math.cos(a*k),wi=Math.sin(a*k),u=i+k,v=u+len/2,xr=re[v]*wr-im[v]*wi,xi=re[v]*wi+im[v]*wr;re[v]=re[u]-xr;im[v]=im[u]-xi;re[u]+=xr;im[u]+=xi}}
if(inv)for(let i=0;i<n;i++){re[i]/=n;im[i]/=n}}
// 2-D transform: FFT every row, then every column
function fft2(re,im,inv){const a=new Float64Array(R),b=new Float64Array(R);
for(let y=0;y<R;y++)fft(re.subarray(y*R,y*R+R),im.subarray(y*R,y*R+R),inv);
for(let x=0;x<R;x++){for(let y=0;y<R;y++){a[y]=re[y*R+x];b[y]=im[y*R+x]}fft(a,b,inv);for(let y=0;y<R;y++){re[y*R+x]=a[y];im[y*R+x]=b[y]}}}
// Every frequency (u,v) gets a distance from the centre of the spectrum: small = broad shapes, large = fine detail.
// Coefficients are sorted by that distance and split into bands; band b belongs to note b.
const band=new Uint16Array(R*R),dd=i=>{const u=i/R|0,v=i%R;return Math.hypot(Math.min(u,R-u),Math.min(v,R-v))},idx=[...Array(R*R).keys()].sort((a,b)=>dd(a)-dd(b));
let co,nz;
function layout(){let r0=0,pv=-1;idx.forEach((i,r)=>{const d=dd(i);if(Math.abs(d-pv)>1e-9){r0=r;pv=d}band[i]=Math.min(N.length-1,Math.floor(N.length*Math.sqrt(r0/(R*R))))});
// with many notes the lowest bands would be empty (a note that unlocks nothing): renumber the non-empty bands and spread them evenly over the notes
const used=[...new Set(band)].sort((a,b)=>a-b),K=used.length,map=new Map(used.map((b,k)=>[b,Math.min(N.length-1,Math.floor(k*N.length/K))]));
for(let i=0;i<R*R;i++)band[i]=map.get(band[i]);prep()}
const ic=$("reveal").getContext("2d"),fc=document.createElement("canvas");fc.width=fc.height=R;
const fg=fc.getContext("2d"),fi=fg.createImageData(R,R);
function prep(){const c=document.createElement("canvas");c.width=c.height=R;const g=c.getContext("2d");g.drawImage(src,0,0,R,R);const d=g.getImageData(0,0,R,R).data;
// forward transform of each colour channel: pixels in, (real, imaginary) frequency numbers out
co=[0,1,2].map(ch=>{const re=new Float64Array(R*R),im=new Float64Array(R*R);for(let i=0;i<R*R;i++)re[i]=d[i*4+ch]-128;fft2(re,im,false);return{re,im}});
// the "static": noise with the same strength as the band it replaces.
// It is made by transforming real white noise, so it has the same conjugate symmetry as a real image's spectrum
// (random independent re/im values lose half their energy when the inverse transform's real part is taken).
nz=co.map(F=>{const re=new Float64Array(R*R),im=new Float64Array(R*R),es=new Float64Array(N.length),en=new Float64Array(N.length);
const g=()=>Math.sqrt(-2*Math.log(Math.random()||1e-9))*Math.cos(6.283185307*Math.random());
for(let i=0;i<R*R;i++)re[i]=g();fft2(re,im,false);
for(let i=0;i<R*R;i++){es[band[i]]+=F.re[i]*F.re[i]+F.im[i]*F.im[i];en[band[i]]+=re[i]*re[i]+im[i]*im[i]}
for(let i=0;i<R*R;i++){const s=Math.sqrt(es[band[i]]/(en[band[i]]||1));re[i]*=s;im[i]*=s}return{re,im}})}
function drawFreq(t){const out=co.map((F,ch)=>{const re=new Float64Array(R*R),im=new Float64Array(R*R);
for(let i=0;i<R*R;i++){const n=N[band[i]];if(t<n.start)continue;const w=Math.max(.15,n.score||0);re[i]=F.re[i]*w+nz[ch].re[i]*(1-w);im[i]=F.im[i]*w+nz[ch].im[i]*(1-w)}
fft2(re,im,true);return re});
for(let i=0;i<R*R;i++){for(let ch=0;ch<3;ch++)fi.data[i*4+ch]=out[ch][i]+128;fi.data[i*4+3]=255}
fg.putImageData(fi,0,0);ic.imageSmoothingEnabled=true;ic.drawImage(fc,0,0,R,R,0,0,S,S)}

// ---------- pitch detection (YIN) ----------
function detect(buf,sr){let e=0;for(const v of buf)e+=v*v;if(Math.sqrt(e/buf.length)<.015)return null;
const max=Math.floor(sr/80),W=buf.length-max,d=new Float32Array(max);let sum=0;
for(let tau=1;tau<max;tau++){let s=0;for(let j=0;j<W;j+=2){const x=buf[j]-buf[j+tau];s+=x*x}sum+=s;d[tau]=s*tau/sum}
let tau=Math.floor(sr/1000);while(tau<max-1&&d[tau]>=.15)tau++;
if(tau>=max-1)return null;while(tau<max-1&&d[tau+1]<d[tau])tau++;
let tt=tau;if(tau>1){const a=d[tau-1],b=d[tau],c=d[tau+1],q=a-2*b+c;if(q>0)tt=tau+(a-c)/(2*q)}
return{hz:sr/tt,clarity:1-d[tau]}}

// ---------- your own song: find the melody in an audio file ----------
async function extract(buf){const x0=buf.getChannelData(0),x1=buf.numberOfChannels>1?buf.getChannelData(1):x0,f=4,n=Math.floor(x0.length/f),y=new Float32Array(n),sr=buf.sampleRate/f;
let mx=0;for(let i=0;i<n;i++){let s=0;for(let k=0;k<f;k++)s+=x0[i*f+k]+x1[i*f+k];y[i]=s/(2*f);mx=Math.max(mx,Math.abs(y[i]))}
if(mx>0)for(let i=0;i<n;i++)y[i]*=.5/mx;
const W=1024,hop=Math.round(sr*.012),notes=[];let cur=[],pk=0,ph=0;
const med=a=>a.map(v=>v.m).sort((p,q)=>p-q)[a.length>>1];
const close=()=>{if(cur.length&&cur[cur.length-1].t-cur[0].t>=.1){const s=cur[0].t,e=cur[cur.length-1].t+.012;
if(notes.length&&s-notes[notes.length-1].end>=.4)ph++;notes.push({start:s,end:e,midi:Math.round(med(cur)),phrase:ph})}cur=[]};
for(let p=0,c=0;p+W<=n;p+=hop,c++){const q=detect(y.subarray(p,p+W),sr),t=(p+W/2)/sr;let e=0;
for(let k=W/2-64;k<W/2+64;k++)e+=y[p+k]*y[p+k];e=Math.sqrt(e/128);pk=cur.length?Math.max(e,pk*.99):e;
const m=q?69+12*Math.log2(q.hz/440):0;if(q&&q.clarity>.85&&m>=46&&m<=81){if(cur.length&&(Math.abs(m-med(cur))>.7||e<.4*pk)){close();pk=e}cur.push({t,m})}else close();
if(c%300===0){$("bmsg").textContent="Listening for notes... "+Math.round(100*p/n)+"%";await new Promise(r=>setTimeout(r))}}
close();return notes}
$("build").onclick=async()=>{const sf=$("songf").files[0],vf=$("vocf").files[0]||sf,m=$("bmsg");
if(running)return;if(!sf){m.textContent="Choose a song file first.";return}
try{m.textContent="Reading the audio...";
const dec=f=>f.arrayBuffer().then(b=>new OfflineAudioContext(1,1,44100).decodeAudioData(b));
const buf=await dec(vf);
const notes=await extract(buf);
if(notes.length<5){m.textContent="Only found "+notes.length+" notes. Try a vocals-only file.";return}
notes.forEach(n=>{n.start+=LEAD;n.end+=LEAD;n.score=0});
SONG.buf=vf===sf?buf:await dec(sf);N.length=0;N.push(...notes);layout();drawFreq(-1);$("songTitle").textContent=sf.name;$("songMeta").textContent=notes.length+" notes · your song";
m.textContent="Found "+notes.length+" notes. "+(vf===sf&&buf.duration>20?"No vocals-only file was added, so these notes may not match the singing. Leave the guide tone on and listen to check them.":"Press Start.")}
catch(e){m.textContent="Couldn’t read that file: "+e.message}};

$("songf").onchange=()=>$("songName").textContent=$("songf").files[0]?$("songf").files[0].name:"Built-in tune";
$("vocf").onchange=()=>$("vocName").textContent=$("vocf").files[0]?$("vocf").files[0].name:"Optional, finds the tune better";

// ---------- audio ----------
let ctx,an,buf,T0,L=.05,stream,running=false,reads=[],keyOff=0,total=0,last=0,LL=0;
try{L=+(localStorage.getItem("lat")||.05)}catch(e){}
function tone(m,t,d,v,type="triangle"){const o=ctx.createOscillator(),g=ctx.createGain();o.type=type;o.frequency.value=hz(m);
g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(v,t+.02);g.gain.exponentialRampToValueAtTime(.001,t+d);
o.connect(g).connect(ctx.destination);o.start(t);o.stop(t+d+.05)}
function backing(){const b=60/SONG.bpm;CH.split(" ").forEach((c,i)=>CHORD[c].forEach(m=>tone(m,T0+LEAD+i*2*b,1.8*b,.12)))}
function simulate(){const o=ctx.createOscillator(),g=ctx.createGain();o.type="sine";g.gain.value=0;o.connect(g).connect(an);
N.forEach(n=>{o.frequency.setValueAtTime(hz(n.midi),T0+n.start);g.gain.setValueAtTime(.3,T0+n.start);g.gain.setValueAtTime(0,T0+n.end)});o.start()}
async function start(virtual){
if(running)return;if(!hasImage){$("sessionTitle").textContent="Choose an image first";$("sessionText").textContent="Upload a picture so the notes have something to reveal.";return}
if(ctx)try{ctx.close()}catch(e){}
$("res").innerHTML="";$("msg").textContent="";
try{ctx=new AudioContext();await ctx.resume();an=ctx.createAnalyser();an.fftSize=2048;buf=new Float32Array(2048);
if(!virtual){stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});ctx.createMediaStreamSource(stream).connect(an)}
T0=ctx.currentTime+.4;
if(virtual)simulate();
const bb=60/SONG.bpm;for(let i=1;i<4;i++)tone(88,T0+LEAD-(4-i)*bb,.1,.25,"sine");
if(SONG.buf){const s=ctx.createBufferSource();s.buffer=SONG.buf;s.connect(ctx.destination);s.start(T0+LEAD)}else backing();
if($("guide").checked)N.forEach(n=>tone(n.midi,T0+n.start,n.end-n.start,.15,"sine"))}
catch(e){$("msg").textContent="That didn’t work: "+e.message+" (the mic needs localhost or https)";return}
LL=virtual?0:L;reads=[];keyOff=0;last=0;N.forEach(n=>n.score=0);running=true;
$("go").disabled=$("test").disabled=true;$("stop").disabled=false;$("status").textContent="Singing live";$("sessionTitle").textContent="You’re on the mic";$("sessionText").textContent="Follow each target note. Accurate notes bring back more of the image.";loop()}
function halt(){running=false;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}try{ctx.close()}catch(e){}
$("go").disabled=$("test").disabled=false;$("stop").disabled=true}
function loop(){if(!running)return;requestAnimationFrame(loop);
const t=ctx.currentTime-T0;an.getFloatTimeDomainData(buf);const p=detect(buf,ctx.sampleRate),ok=p&&p.clarity>.85;
if(ok)reads.push({t:t-LL,hz:p.hz});
$("livePitch").textContent="Pitch: "+(ok?name(Math.round(69+12*Math.log2(p.hz/440))):"–");
const n=near(t-LL,0);$("tgt").textContent=n?name(n.midi):"–";
if(n&&ok){const e=fold(cents(p.hz,n.midi)-keyOff);$("diff").textContent=Math.abs(e)<=50?"In tune":Math.round(Math.abs(e))+" cents "+(e<0?"flat":"sharp");$("pitchMarker").style.left=(50+Math.max(-1,Math.min(1,e/300))*45)+"%"}
else{$("diff").textContent=n?"Sing the target note":"";$("pitchMarker").style.left="50%"}
if(t-last>.2){last=t;recompute();drawFreq(t)}
drawSpectrum();
if(t>N[N.length-1].end+1.5)finish()}

// ---------- scoring ----------
function recompute(){const[tol,slack,ease]=LV[$("lvl").value];keyOff=0;
if($("key").checked){const e=[];for(const r of reads){const n=near(r.t,.15);if(n&&r.t<N[0].start+5)e.push(fold(cents(r.hz,n.midi)))}
if(e.length>15){e.sort((a,b)=>a-b);keyOff=e[e.length>>1]}}
N.forEach(n=>n.bins=new Array(Math.ceil((n.end-n.start)/PX)).fill(0));
for(const r of reads){const n=near(r.t,slack);if(!n)continue;
const e=Math.abs(fold(cents(r.hz,n.midi)-keyOff)),c=e<=tol?1:Math.max(0,1-(e-tol)/tol);
const i=Math.min(n.bins.length-1,Math.max(0,Math.floor((r.t-n.start)/PX)));n.bins[i]=Math.max(n.bins[i],c)}
let a=0,b=0;N.forEach(n=>{n.score=Math.min(1,n.bins.reduce((x,y)=>x+y,0)/n.bins.length/ease);a+=n.score*(n.end-n.start);b+=n.end-n.start});
total=a/b;const pc=Math.round(total*100)+"%";$("score").textContent=pc;$("clarity").textContent=pc;$("clarityBar").style.width=pc}

// ---------- microphone spectrum ----------
const spectrum=$("spectrum"),sx=spectrum.getContext("2d");
function drawSpectrum(){spectrum.width=spectrum.clientWidth*devicePixelRatio;spectrum.height=spectrum.clientHeight*devicePixelRatio;
const a=new Uint8Array(an.frequencyBinCount);an.getByteFrequencyData(a);const w=spectrum.width,h=spectrum.height,count=110,bw=w/count;
sx.fillStyle="#10151c";sx.fillRect(0,0,w,h);
for(let i=0;i<count;i++){const bh=a[i]/255*(h-8);sx.fillStyle=i%5===0?"#ffb454":"#6596d6";sx.fillRect(i*bw,h-bh,Math.max(1,bw-2),bh)}}

// ---------- results ----------
function finish(){halt();recompute();drawFreq(1e9);$("status").textContent="Song complete";
const P={};N.forEach(n=>(P[n.phrase]=P[n.phrase]||[]).push(n.score));
const ps=Object.keys(P).map(k=>[+k,P[k].reduce((a,b)=>a+b)/P[k].length]),w=Math.min(...ps.map(p=>p[1])),mx=Math.max(...ps.map(p=>p[1])),isW=v=>w<mx&&v===w;
$("sessionTitle").textContent="Performance complete";
$("sessionText").textContent="Your final accuracy is "+Math.round(total*100)+"%. Try again to bring back more of the image.";
let h="";ps.forEach(([k,v])=>h+="<div class=\"line\">Line "+(k+1)+(isW(v)?" (weakest)":"")+" · "+Math.round(v*100)+"%<div class=\"bar"+(isW(v)?" weak":"")+"\" style=\"width:"+Math.max(2,v*100)+"%\"></div></div>");
$("res").innerHTML=h+"<p class=\"line\">Original picture</p>";
const o=document.createElement("canvas");o.width=o.height=S;o.className="orig";o.getContext("2d").drawImage(src,0,0);$("res").append(o)}

$("go").onclick=()=>start(false);$("test").onclick=()=>start(true);$("stop").onclick=()=>{halt();$("status").textContent="Stopped"};
$("resetBtn").onclick=()=>{if(running)halt();N.forEach(n=>n.score=0);reads=[];$("res").innerHTML="";$("msg").textContent="";
$("status").textContent="Waiting to start";$("score").textContent="—";$("clarity").textContent="0%";$("clarityBar").style.width="0%";
$("tgt").textContent="–";$("diff").textContent="Start the song to begin";$("pitchMarker").style.left="50%";
$("sessionTitle").textContent="Ready when you are";$("sessionText").textContent="Upload a picture, then start the song. The image is processed locally in your browser.";drawFreq(-1)};
layout();drawFreq(-1);
