"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ─── Tokens ────────────────────────────────────────────────────────────────────
const T = {
  bg0:"#131110",bg1:"#1A1714",bg2:"#23201B",bg3:"#2D2924",bg4:"#38342E",
  text1:"#EDEBE7",text2:"#A09890",text3:"#6B6560",text4:"#403C38",
  coral:"#E0956A",sage:"#8BB09A",gold:"#C4A882",steel:"#A5B8D0",rose:"#C9A0B8",
  strength:{main:"#E0956A",dim:"rgba(224,149,106,0.10)",glow:"rgba(224,149,106,0.18)"},
  zone2:   {main:"#A5B8D0",dim:"rgba(165,184,208,0.10)",glow:"rgba(165,184,208,0.14)"},
  hiit:    {main:"#C9A0B8",dim:"rgba(201,160,184,0.10)",glow:"rgba(201,160,184,0.16)"},
  cardio:  {main:"#A5B8D0",dim:"rgba(165,184,208,0.09)",glow:"rgba(165,184,208,0.12)"},
  rest:    {main:"#6B6560",dim:"rgba(107,101,96,0.08)", glow:"rgba(107,101,96,0.10)"},
  serif:"'Fraunces', serif", sans:"'DM Sans', sans-serif",
  r:{sm:8,md:14,lg:20,xl:28,pill:999},
  ease:"cubic-bezier(0.22, 1, 0.36, 1)",
};

// ─── localStorage (SSR-safe) ──────────────────────────────────────────────────
const LS = {
  get:(key,fb=null)=>{
    if(typeof window==="undefined") return fb;
    try{const v=localStorage.getItem(key);return v!==null?JSON.parse(v):fb;}
    catch{return fb;}
  },
  set:(key,val)=>{
    if(typeof window==="undefined") return;
    try{localStorage.setItem(key,JSON.stringify(val));}catch{}
  },
};

const P = {
  list:        ()        => LS.get("forge:profiles",[]),
  add:         (n)       => { const p=P.list(); if(!p.includes(n)) LS.set("forge:profiles",[...p,n]); },
  getActive:   ()        => LS.get("forge:active",null),
  setActive:   (n)       => LS.set("forge:active",n),
  getWeights:  (n)       => LS.get(`forge:${n}:weights`,{}),
  saveWeights: (n,w)     => LS.set(`forge:${n}:weights`,w),
  getReps:     (n)       => LS.get(`forge:${n}:reps`,{}),
  saveReps:    (n,r)     => LS.set(`forge:${n}:reps`,r),
  getStreak:   (n)       => LS.get(`forge:${n}:streak`,{count:0,lastDate:null}),
  saveStreak:  (n,s)     => LS.set(`forge:${n}:streak`,s),
};

function bumpStreak(name){
  const today=new Date().toISOString().slice(0,10);
  const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const {count,lastDate}=P.getStreak(name);
  if(lastDate===today) return count;
  const next=lastDate===yesterday?count+1:1;
  P.saveStreak(name,{count:next,lastDate:today});
  return next;
}

// ─── Blob sync (fire-and-forget, never blocks UI) ─────────────────────────────
async function blobPull(profile){
  try{
    const res=await fetch(`/api/sync?profile=${encodeURIComponent(profile)}`);
    if(!res.ok) return null;
    return await res.json();
  }catch{return null;}
}
async function blobPush(profile,data){
  try{
    await fetch("/api/sync",{
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({profile,data}),
    });
  }catch{/* silent — localStorage is source of truth */}
}

// ─── Progression ──────────────────────────────────────────────────────────────
const roundPlate=(kg)=>Math.round(kg/1.25)*1.25;
function applyRpe(weight,rpe){
  if(weight===null||weight===undefined) return weight;
  if(rpe==="easy")  return roundPlate(weight*1.025);
  if(rpe==="limit") return roundPlate(weight*0.95);
  return weight;
}

// ─── Programme ────────────────────────────────────────────────────────────────
const WEEK=[
  {s:"M",label:"Strength",type:"strength",done:false,today:false},
  {s:"T",label:"Zone 2",  type:"zone2",   done:false,today:false},
  {s:"W",label:"Strength",type:"strength",done:false,today:false},
  {s:"T",label:"Cardio",  type:"cardio",  done:false,today:false},
  {s:"F",label:"Strength",type:"strength",done:false,today:false},
  {s:"S",label:"HIIT",    type:"hiit",    done:false,today:false},
  {s:"S",label:"Rest",    type:"rest",    done:false,today:false},
];

const SESSION={
  name:"Strength A",type:"strength",
  blocks:[
    {id:"a1",type:"main",     label:"Main lift · 1 of 2",sets:3,rest:180,
     ex: {name:"Barbell Back Squat",   reps:5,     weight:100,muscle:"Quadriceps",    vid:"nEQQle9-0NA"}},
    {id:"a2",type:"main",     label:"Main lift · 2 of 2",sets:3,rest:180,
     ex: {name:"Barbell Bench Press",  reps:5,     weight:80, muscle:"Chest",         vid:"4Y2ZdHCOXok"}},
    {id:"ss1",type:"superset",label:"Superset · 1 of 2", sets:3,rest:90,
     exA:{name:"Barbell Reverse Lunge",reps:"8/leg",weight:60,muscle:"Quads & Glutes",vid:"AIR5XoiQJaI"},
     exB:{name:"Romanian Deadlift",    reps:8,     weight:80, muscle:"Hamstrings",    vid:"hCDzSR6bW10"}},
    {id:"ss2",type:"superset",label:"Superset · 2 of 2", sets:3,rest:90,
     exA:{name:"Barbell Hip Thrust",   reps:10,    weight:100,muscle:"Glutes",        vid:"xDmFkJxPzeM"},
     exB:{name:"Landmine Press",       reps:10,    weight:30, muscle:"Upper chest",   vid:"QMrm2WMbj3k"}},
    {id:"fin",type:"finisher",label:"Finisher",           sets:2,rest:60,
     exA:{name:"Hanging Leg Raise",    reps:10,    weight:null,muscle:"Core",         vid:"hdng3Nm1x_E"},
     exB:{name:"Dead Bug",             reps:10,    weight:null,muscle:"Core / Anti-rot",vid:"g_BYB0R-4Ws"}},
  ],
};

// ─── Fade hook ─────────────────────────────────────────────────────────────────
function useFadeIn(d=0){
  const [v,setV]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setV(true),d);return()=>clearTimeout(t);},[d]);
  return{opacity:v?1:0,transform:v?"translateY(0)":"translateY(10px)",
         transition:`opacity 260ms ${T.ease} ${d}ms,transform 260ms ${T.ease} ${d}ms`};
}

// ─── ScrollDrum ────────────────────────────────────────────────────────────────
function ScrollDrum({value,onChange,step=1.25,min=0,max=500,integer=false,label=""}){
  const ITEM_H=52,VISIBLE=5,half=Math.floor(VISIBLE/2);
  const values=useMemo(()=>{
    const arr=[];
    if(integer){for(let v=Math.max(min,1);v<=max;v++) arr.push(v);}
    else{const s=Math.round((max-min)/step);for(let i=0;i<=s;i++) arr.push(Math.round((min+i*step)*100)/100);}
    return arr;
  },[min,max,step,integer]);
  const current=parseFloat(value)||0;
  const selectedIdx=Math.max(0,values.findIndex(v=>Math.abs(v-current)<step*0.5));
  const ref=useRef(null);
  const scrolling=useRef(false);
  const timer=useRef(null);
  useEffect(()=>{
    if(!ref.current||scrolling.current) return;
    const raf=requestAnimationFrame(()=>{ if(ref.current) ref.current.scrollTop=selectedIdx*ITEM_H; });
    return()=>cancelAnimationFrame(raf);
  },[selectedIdx]);
  const onScroll=useCallback(()=>{
    if(!ref.current) return;
    scrolling.current=true;
    const idx=Math.min(Math.round(ref.current.scrollTop/ITEM_H),values.length-1);
    const next=values[Math.max(0,idx)];
    if(next!==undefined&&Math.abs(next-current)>(integer?0.1:0.01)) onChange(next);
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>{scrolling.current=false;},150);
  },[values,current,onChange,integer]);
  const fmt=(v)=>{
    if(integer) return String(Math.round(v));
    const n=Math.round(v*100)/100;
    return Number.isInteger(n)?String(n):n.toFixed(2).replace(/0+$/,"").replace(/\.$/,"");
  };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",flex:1}}>
      {label&&<div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>{label}</div>}
      <div style={{position:"relative",height:ITEM_H*VISIBLE,width:"100%",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:ITEM_H,transform:"translateY(-50%)",background:`${T.coral}14`,borderTop:`1px solid ${T.coral}33`,borderBottom:`1px solid ${T.coral}33`,pointerEvents:"none",zIndex:1,borderRadius:T.r.sm}}/>
        <div style={{position:"absolute",top:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to bottom,${T.bg2} 30%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div style={{position:"absolute",bottom:0,left:0,right:0,height:ITEM_H*1.8,background:`linear-gradient(to top,${T.bg2} 30%,transparent)`,pointerEvents:"none",zIndex:2}}/>
        <div ref={ref} onScroll={onScroll} style={{height:"100%",overflowY:"scroll",scrollSnapType:"y mandatory",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",paddingTop:ITEM_H*half,paddingBottom:ITEM_H*half,boxSizing:"content-box"}}>
          <style>{`*::-webkit-scrollbar{display:none}`}</style>
          {values.map((v,i)=>{
            const sel=i===selectedIdx;
            return(
              <div key={i} onClick={()=>onChange(v)} style={{height:ITEM_H,scrollSnapAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <span style={{fontFamily:T.serif,fontSize:sel?30:20,fontWeight:sel?400:300,color:sel?T.text1:T.text4,transition:`all 140ms ${T.ease}`,userSelect:"none"}}>{fmt(v)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{fontFamily:T.serif,fontSize:12,fontWeight:300,color:T.text3,marginTop:8,fontStyle:"italic"}}>{integer?"reps":"kg"}</div>
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function ForgeApp(){
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);

  const [activeProfile,setActiveProfileState]=useState(()=>typeof window!=="undefined"?P.getActive():null);
  const [showProfiles,setShowProfiles]=useState(false);
  const [streak,setStreak]=useState(0);
  const [screen,setScreen]=useState("home");
  const [blockIdx,setBlockIdx]=useState(0);
  const [setNum,setSetNum]=useState(1);
  const [phase,setPhase]=useState("A");
  const [readiness,setReadiness]=useState(null);
  const [showVid,setShowVid]=useState(false);
  const [editTarget,setEditTarget]=useState(null);
  const [awaitRpe,setAwaitRpe]=useState(false);
  const [ssRoundDone,setSsRoundDone]=useState(false);
  const [workingWeights,setWWState]=useState({});
  const [workingReps,setWRState]=useState({});
  const [restActive,setRestActive]=useState(false);
  const [restRemain,setRestRemain]=useState(180);
  const [restTrigger,setRestTrigger]=useState(null);

  // Fonts
  useEffect(()=>{
    const l=document.createElement("link");
    l.rel="stylesheet";
    l.href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;1,9..144,300;1,9..144,400&family=DM+Sans:wght@300;400;500;600&display=swap";
    document.head.appendChild(l);
    return()=>{try{document.head.removeChild(l);}catch(_){}};
  },[]);

  // Seed on profile change + pull from blob
  useEffect(()=>{
    if(!activeProfile) return;
    setWWState(P.getWeights(activeProfile));
    setWRState(P.getReps(activeProfile));
    setStreak(P.getStreak(activeProfile).count);
    // Pull from blob and merge (handles new device)
    blobPull(activeProfile).then(remote=>{
      if(!remote) return;
      setWWState(prev=>{
        const merged={...prev,...remote.weights};
        P.saveWeights(activeProfile,merged);
        return merged;
      });
      setWRState(prev=>{
        const merged={...prev,...remote.reps};
        P.saveReps(activeProfile,merged);
        return merged;
      });
      if(remote.streak?.count>P.getStreak(activeProfile).count){
        P.saveStreak(activeProfile,remote.streak);
        setStreak(remote.streak.count);
      }
    });
  },[activeProfile]);

  // Rest timer tick
  useEffect(()=>{
    if(!restActive) return;
    if(restRemain<=0){setRestActive(false);return;}
    const t=setTimeout(()=>setRestRemain(p=>p-1),1000);
    return()=>clearTimeout(t);
  },[restActive,restRemain]);

  useEffect(()=>{
    if(!restTrigger) return;
    setRestRemain(restTrigger.duration);
    setRestActive(true);
  },[restTrigger]);

  // Persist-aware setters
  const setWW=useCallback((upd)=>{
    setWWState(prev=>{
      const next=typeof upd==="function"?upd(prev):upd;
      if(activeProfile) P.saveWeights(activeProfile,next);
      return next;
    });
  },[activeProfile]);
  const setWR=useCallback((upd)=>{
    setWRState(prev=>{
      const next=typeof upd==="function"?upd(prev):upd;
      if(activeProfile) P.saveReps(activeProfile,next);
      return next;
    });
  },[activeProfile]);

  const activateProfile=async(name)=>{
    P.add(name); P.setActive(name);
    setActiveProfileState(name);
    setShowProfiles(false);
  };

  const block    = SESSION.blocks[blockIdx];
  const isSS     = block.type==="superset"||block.type==="finisher";
  const activeEx = isSS?(phase==="A"?block.exA:block.exB):block.ex;
  const getW=useCallback((ex)=>ex?(workingWeights[ex.name]??ex.weight):null,[workingWeights]);
  const getR=useCallback((ex)=>ex?(workingReps[ex.name]??ex.reps):null,[workingReps]);

  const commitLog=useCallback((rpe)=>{
    const exes=isSS?[block.exA,block.exB]:[block.ex];
    const updates={};
    exes.forEach(ex=>{
      if(!ex) return;
      const w=workingWeights[ex.name]??ex.weight;
      if(w!==null&&w!==undefined){const n=applyRpe(w,rpe);if(n!==w) updates[ex.name]=n;}
    });
    if(Object.keys(updates).length) setWW(p=>({...p,...updates}));
    if(setNum>=block.sets){
      if(blockIdx<SESSION.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
      else setScreen("done");
    }else setSetNum(p=>p+1);
    setRestTrigger({id:Date.now(),duration:block.rest});
    setSsRoundDone(false);
    setAwaitRpe(false);
  },[block,blockIdx,isSS,setNum,workingWeights,setWW]);

  const handleLog=useCallback(()=>{
    if(isSS){
      if(phase==="A"){setPhase("B");return;}
      setPhase("A");
      if(block.type==="superset"){setSsRoundDone(true);return;}
      // Finisher — advance silently
      if(setNum>=block.sets){
        if(blockIdx<SESSION.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
        else setScreen("done");
      }else setSetNum(p=>p+1);
      setRestTrigger({id:Date.now(),duration:block.rest});
      return;
    }
    setAwaitRpe(true);
  },[block,blockIdx,isSS,phase,setNum]);

  const reset=()=>{
    setBlockIdx(0);setSetNum(1);setPhase("A");setReadiness(null);
    setAwaitRpe(false);setSsRoundDone(false);
    setRestActive(false);setRestRemain(180);setRestTrigger(null);
    setScreen("home");
  };

  const onSessionDone=useCallback(()=>{
    if(!activeProfile) return;
    const newStreak=bumpStreak(activeProfile);
    setStreak(newStreak);
    // Push to blob
    blobPush(activeProfile,{
      weights:workingWeights,
      reps:workingReps,
      streak:P.getStreak(activeProfile),
    });
    setScreen("done");
  },[activeProfile,workingWeights,workingReps]);

  // Show done screen via commitLog completing last block
  useEffect(()=>{
    if(screen==="done"&&activeProfile){
      const newStreak=bumpStreak(activeProfile);
      setStreak(newStreak);
      blobPush(activeProfile,{
        weights:workingWeights,
        reps:workingReps,
        streak:P.getStreak(activeProfile),
      });
    }
  // Only run when we transition to done
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[screen==="done"]);

  if(!mounted) return null;

  if(!activeProfile||showProfiles){
    return <ProfileScreen existing={P.list()} current={activeProfile} onActivate={activateProfile} onCancel={showProfiles?()=>setShowProfiles(false):null}/>;
  }

  const sProps={
    block,blockIdx,totalBlocks:SESSION.blocks.length,setNum,phase,isSS,activeEx,
    showVid,setShowVid,getW,getR,editTarget,setEditTarget,
    workingWeights,setWW,workingReps,setWR,
    awaitRpe,ssRoundDone,
    restActive,restRemain,setRestActive,setRestRemain,
    onCommit:commitLog,onLog:handleLog,onQuit:reset,
  };

  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased"}}>
      {screen==="home"      && <HomeScreen      streak={streak} profileName={activeProfile} onBegin={()=>setScreen("readiness")} onProfile={()=>setShowProfiles(true)}/>}
      {screen==="readiness" && <ReadinessScreen readiness={readiness} setReadiness={setReadiness} onStart={()=>setScreen("session")}/>}
      {screen==="session"   && <SessionScreen   {...sProps}/>}
      {screen==="done"      && <DoneScreen       profileName={activeProfile} workingWeights={workingWeights} onHome={reset}/>}
    </div>
  );
}

// ─── Profile Screen ────────────────────────────────────────────────────────────
function ProfileScreen({existing,current,onActivate,onCancel}){
  const [name,setName]=useState("");
  const {strength:s}=T;
  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,marginBottom:32,display:"block"}}>← Back</button>}
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:36,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          {current?"Switch profile":"Who's training?"}
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:36,lineHeight:1.6}}>
          {current?"Pick a profile or add someone new.":"Your name keeps your streak and weights separate from everyone else."}
        </p>
      </Fade>
      {existing.length>0&&(
        <Fade d={60}>
          <div style={{marginBottom:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>On this device</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {existing.map(n=>(
                <div key={n} onClick={()=>onActivate(n)} style={{padding:"16px 20px",borderRadius:T.r.lg,cursor:"pointer",background:n===current?`${T.coral}12`:T.bg2,border:`1px solid ${n===current?T.coral+"44":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
                  <span style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1}}>{n}</span>
                  {n===current&&<span style={{fontSize:11,color:T.coral,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Active</span>}
                </div>
              ))}
            </div>
          </div>
        </Fade>
      )}
      <Fade d={120}>
        <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Add new</div>
        <div style={{display:"flex",gap:10}}>
          <input value={name} onChange={e=>setName(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&name.trim()) onActivate(name.trim());}}
            placeholder="Your name"
            style={{flex:1,background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,padding:"14px 16px",fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,outline:"none",caretColor:T.coral}}
          />
          <button onClick={()=>name.trim()&&onActivate(name.trim())}
            style={{padding:"14px 20px",background:name.trim()?T.coral:T.bg3,border:"none",borderRadius:T.r.md,cursor:name.trim()?"pointer":"default",fontFamily:T.serif,fontSize:18,fontWeight:400,color:name.trim()?T.bg0:T.text4,transition:`all 200ms ${T.ease}`}}>→</button>
        </div>
      </Fade>
    </div>
  );
}

// ─── Home ──────────────────────────────────────────────────────────────────────
function HomeScreen({streak,profileName,onBegin,onProfile}){
  const {strength:s}=T;
  const today=new Date().toISOString().slice(0,10);
  const dow=new Date().getDay(); // 0=Sun
  const weekMap=[6,0,1,2,3,4,5]; // Mon=0 ... Sun=6 → WEEK index
  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-180,left:"50%",transform:"translateX(-50%)",width:600,height:500,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <Fade d={0}>
        <div style={{padding:"52px 24px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div>
            <div style={{fontFamily:T.serif,fontSize:13,fontWeight:300,color:T.text2,fontStyle:"italic"}}>
              {new Date().toLocaleDateString("en-GB",{weekday:"long"})}
            </div>
            <div style={{fontFamily:T.serif,fontSize:28,fontWeight:400,lineHeight:1.15,marginTop:2}}>
              {new Date().toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
            <StreakBadge count={streak}/>
            <button onClick={onProfile} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:11,color:T.text3,fontFamily:T.sans,fontWeight:500}}>
              {profileName} ↗
            </button>
          </div>
        </div>
      </Fade>
      <Fade d={60}>
        <div style={{padding:"32px 24px 0"}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>Today</div>
          <div style={{fontFamily:T.serif,fontSize:42,fontWeight:300,lineHeight:1.1}}>
            Strength<br/><span style={{color:s.main,fontStyle:"italic"}}>Day A</span>
          </div>
          <div style={{fontSize:14,color:T.text2,marginTop:10,lineHeight:1.5}}>Squat · Bench · Hinge &amp; Hip thrust</div>
        </div>
      </Fade>
      <Fade d={120}>
        <div style={{padding:"28px 24px 0",display:"flex",gap:8}}>
          {WEEK.map((d,i)=>{
            const a=T[d.type];
            const isToday=i===weekMap[dow];
            return (
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
                <div style={{width:34,height:34,borderRadius:"50%",background:isToday?a.main:T.bg2,border:`1px solid ${isToday?a.main:T.bg3}`,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:isToday?`0 0 20px ${a.glow}`:"none"}}>
                  <span style={{fontSize:12,fontWeight:500,color:isToday?T.bg0:T.text3}}>{d.s}</span>
                </div>
                <span style={{fontSize:8,fontWeight:500,color:isToday?a.main:T.text4,letterSpacing:"0.06em",textTransform:"uppercase"}}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </Fade>
      <Fade d={180}>
        <Card style={{margin:"24px 24px 0",padding:0,overflow:"hidden"}}>
          <div style={{height:2,background:`linear-gradient(90deg,${T.coral},${T.coral}00)`}}/>
          <div style={{padding:"20px 22px 24px"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>Session overview</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",paddingBottom:18,marginBottom:18,borderBottom:`1px solid ${T.bg3}`}}>
              {[["5","Blocks"],["~65 min","Duration"],["2","Supersets"]].map(([v,l])=>(
                <div key={l}><div style={{fontFamily:T.serif,fontSize:24,fontWeight:400,lineHeight:1}}>{v}</div>
                <div style={{fontSize:11,color:T.text3,marginTop:4}}>{l}</div></div>
              ))}
            </div>
            {[
              {name:"Barbell Back Squat",         detail:"3×5",  tag:"Main"},
              {name:"Barbell Bench Press",         detail:"3×5",  tag:"Main"},
              {name:"Reverse Lunge ↔ RDL",        detail:"3×8",  tag:"Superset"},
              {name:"Hip Thrust ↔ Landmine Press", detail:"3×10", tag:"Superset"},
              {name:"Leg Raise ↔ Dead Bug",        detail:"2×10", tag:"Finisher"},
            ].map((ex,i,arr)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<arr.length-1?`1px solid ${T.bg3}`:"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:ex.tag==="Main"?T.coral:ex.tag==="Superset"?T.sage:T.gold,flexShrink:0}}/>
                  <span style={{fontSize:13,color:T.text1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ex.name}</span>
                </div>
                <span style={{fontFamily:T.serif,fontSize:13,color:T.text3,fontStyle:"italic",flexShrink:0,marginLeft:12}}>{ex.detail}</span>
              </div>
            ))}
          </div>
        </Card>
      </Fade>
      <Fade d={240}>
        <button onClick={onBegin} style={{margin:"16px 24px 0",width:"calc(100% - 48px)",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:`0 12px 40px ${T.strength.glow}`}}>
          <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>Begin session</span>
          <span style={{fontSize:18,color:T.bg0}}>→</span>
        </button>
      </Fade>
    </div>
  );
}

// ─── Readiness ─────────────────────────────────────────────────────────────────
function ReadinessScreen({readiness,setReadiness,onStart}){
  const opts=[
    {id:"fresh",icon:"○",label:"Fresh",sub:"Full programme.",   color:T.sage},
    {id:"normal",icon:"◐",label:"Normal",sub:"Standard session.",color:T.gold},
    {id:"cooked",icon:"●",label:"Cooked",sub:"60% volume.",     color:T.rose},
  ];
  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0"}}>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:34,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
          How are you<br/><span style={{fontStyle:"italic",color:T.coral}}>feeling today?</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:40,lineHeight:1.6}}>We'll shape the session around you.</p>
      </Fade>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {opts.map((o,i)=>(
          <Fade key={o.id} d={80+i*50}>
            <div onClick={()=>setReadiness(o.id)} style={{padding:"18px 20px",borderRadius:T.r.lg,cursor:"pointer",background:readiness===o.id?`${o.color}12`:T.bg2,border:`1px solid ${readiness===o.id?o.color+"55":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 200ms ${T.ease}`}}>
              <div style={{display:"flex",alignItems:"center",gap:16}}>
                <span style={{fontSize:20,color:o.color,opacity:0.8}}>{o.icon}</span>
                <div>
                  <div style={{fontFamily:T.serif,fontSize:20,fontWeight:400}}>{o.label}</div>
                  <div style={{fontSize:12,color:T.text3,marginTop:2}}>{o.sub}</div>
                </div>
              </div>
              <div style={{width:20,height:20,borderRadius:"50%",background:readiness===o.id?o.color:"transparent",border:`1.5px solid ${readiness===o.id?o.color:T.bg4}`,display:"flex",alignItems:"center",justifyContent:"center",transition:`all 180ms ${T.ease}`}}>
                {readiness===o.id&&<span style={{fontSize:10,color:T.bg0}}>✓</span>}
              </div>
            </div>
          </Fade>
        ))}
      </div>
      <Fade d={280}>
        <button onClick={readiness?onStart:undefined} style={{marginTop:28,width:"100%",padding:"18px 24px",background:readiness?T.coral:T.bg2,border:`1px solid ${readiness?T.coral:T.bg3}`,borderRadius:T.r.lg,cursor:readiness?"pointer":"default",fontFamily:T.serif,fontSize:20,fontWeight:400,color:readiness?T.bg0:T.text4,transition:`all 220ms ${T.ease}`,boxShadow:readiness?`0 12px 40px ${T.strength.glow}`:"none"}}>
          Start session →
        </button>
      </Fade>
    </div>
  );
}

// ─── RPE Card ──────────────────────────────────────────────────────────────────
function RpeCard({onPick,label="How was that set?"}){
  const opts=[
    {id:"easy", icon:"😮‍💨",label:"Easy", sub:"More in the tank",color:T.sage},
    {id:"hard", icon:"😤", label:"Hard", sub:"Close to limit",   color:T.gold},
    {id:"limit",icon:"🔥", label:"Limit",sub:"Max effort",       color:T.rose},
  ];
  return (
    <div style={{margin:"14px 20px 0",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,padding:"16px 18px",animation:`fadeSlide 240ms ${T.ease}`}}>
      <style>{`@keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`}</style>
      <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>{label}</div>
      <div style={{display:"flex",gap:8}}>
        {opts.map(o=>(
          <div key={o.id} onClick={()=>onPick(o.id)} style={{flex:1,padding:"12px 6px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",textAlign:"center",transition:`all 180ms ${T.ease}`}}>
            <div style={{fontSize:20,marginBottom:4}}>{o.icon}</div>
            <div style={{fontFamily:T.serif,fontSize:15,fontWeight:400,color:T.text1}}>{o.label}</div>
            <div style={{fontSize:10,color:T.text3,marginTop:2,lineHeight:1.3}}>{o.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Session ───────────────────────────────────────────────────────────────────
function SessionScreen({block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit}){
  const {strength:s}=T;
  const partnerEx=isSS?(phase==="A"?block.exB:block.exA):null;
  const vidEx    =isSS?(phase==="A"?block.exA:block.exB):block.ex;
  const progress =((blockIdx+(setNum-1)/block.sets)/totalBlocks)*100;
  const nameFz   =Math.min(38,Math.max(24,300/(activeEx?.name?.length||10)));
  const typeLabel={main:"Main lift",superset:"Superset",finisher:"Finisher"}[block.type];
  const currentW =getW(activeEx);
  const showRestHint=!isSS;
  const restMins =Math.floor(restRemain/60),restSecs=restRemain%60;
  const restStr  =`${restMins}:${String(restSecs).padStart(2,"0")}`;
  const blocking =awaitRpe||ssRoundDone;

  return (
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",paddingBottom:40}}>
      <div style={{position:"absolute",top:-80,right:-80,width:340,height:320,background:`radial-gradient(circle,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <div style={{height:1,background:T.bg3}}>
        <div style={{height:"100%",width:`${progress}%`,background:T.coral,transition:`width 600ms ${T.ease}`}}/>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onQuit} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans}}>← Quit</button>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.1em",textTransform:"uppercase"}}>Strength A</div>
          <div style={{fontSize:10,color:T.text3,fontStyle:"italic",fontFamily:T.serif,marginTop:1}}>{block.label}</div>
        </div>
      </div>
      <div style={{padding:"14px 20px 0",display:"flex",gap:8,flexWrap:"wrap"}}>
        <Tag color={block.type==="main"?T.coral:block.type==="superset"?T.sage:T.gold}>{typeLabel}</Tag>
        {isSS&&<Tag color={T.steel}>Exercise {phase}</Tag>}
      </div>
      <div style={{padding:"14px 20px 0",cursor:"pointer"}} onClick={()=>setShowVid(true)}>
        <div style={{fontFamily:T.serif,fontSize:nameFz,fontWeight:300,lineHeight:1.1}}>{activeEx?.name}</div>
        <div style={{display:"flex",alignItems:"center",gap:10,marginTop:8}}>
          <span style={{fontSize:11,color:T.coral,fontWeight:500}}>▶ Watch demo</span>
          <span style={{fontSize:11,color:T.text3}}>{activeEx?.muscle}</span>
        </div>
      </div>
      <div style={{padding:"22px 20px 0"}}>
        <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>Set {setNum} of {block.sets}</div>
        {currentW!==null&&(
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4,cursor:"pointer"}} onClick={()=>setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx)})}>
            <span style={{fontFamily:T.serif,fontSize:80,fontWeight:300,color:T.text1,lineHeight:1,letterSpacing:"-0.02em"}}>{currentW}</span>
            <span style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text3,marginBottom:8}}>kg</span>
            <span style={{fontSize:11,color:T.text3,marginBottom:10,marginLeft:4}}>↕</span>
          </div>
        )}
        <div style={{display:"flex",alignItems:"baseline",gap:6,cursor:"pointer"}} onClick={()=>setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx)})}>
          <span style={{fontFamily:T.serif,fontSize:48,fontWeight:400,color:T.coral,lineHeight:1,fontStyle:"italic"}}>{getR(activeEx)}</span>
          <span style={{fontSize:14,color:T.text3,marginBottom:4}}>reps</span>
          <span style={{fontSize:11,color:T.text3,marginBottom:6,marginLeft:4}}>↕</span>
        </div>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",gap:6}}>
        {Array.from({length:block.sets}).map((_,i)=>(
          <div key={i} style={{flex:1,height:3,borderRadius:2,background:i<setNum-1?T.coral:T.bg3,transition:`background 300ms ${T.ease}`}}/>
        ))}
      </div>
      {awaitRpe&&<RpeCard onPick={onCommit} label="How was that set?"/>}
      {ssRoundDone&&<RpeCard onPick={onCommit} label={`Round ${setNum} of ${block.sets} — rate the effort`}/>}
      {!blocking&&(
        <>
          {showRestHint&&(
            <div style={{padding:"12px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:12,color:restActive?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif,transition:`color 300ms ${T.ease}`}}>
                {restActive?`Resting — ${restStr}`:`~${Math.round(block.rest/60)} min rest`}
              </span>
              <button onClick={()=>{if(restActive){setRestActive(false);setRestRemain(block.rest);}else{setRestRemain(block.rest);setRestActive(true);}}}
                style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:restActive?T.coral:T.text3,transition:`all 180ms ${T.ease}`}}>
                {restActive?"Skip":"Start timer"}
              </button>
            </div>
          )}
          {isSS&&phase==="A"&&(
            restActive
              ?(
                <div style={{padding:"12px 20px 0",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:12,color:T.coral,fontStyle:"italic",fontFamily:T.serif}}>Resting — {restStr}</span>
                  <button onClick={()=>{setRestActive(false);setRestRemain(block.rest);}} style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.sm,padding:"4px 10px",cursor:"pointer",fontSize:11,color:T.coral}}>Skip</button>
                </div>
              ):(
                <div style={{padding:"8px 20px 0",fontSize:12,color:T.text3,fontStyle:"italic",fontFamily:T.serif}}>
                  Straight into B — no rest between exercises
                </div>
              )
          )}
          <button onClick={onLog} style={{margin:"12px 20px 0",width:"calc(100% - 40px)",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",boxShadow:`0 8px 28px ${s.glow}`}}>
            <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>
              {isSS?(phase==="A"?"Log A — into B":"Log B — round done"):"Log set"}
            </span>
            <span style={{fontSize:18,color:T.bg0}}>+</span>
          </button>
        </>
      )}
      {isSS&&!blocking&&(
        <Card style={{margin:"14px 20px 0",padding:"14px 18px"}}>
          <div style={{fontSize:10,fontWeight:500,color:T.text4,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>
            {phase==="A"?"Immediately after →":"Just completed ✓"}
          </div>
          <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:phase==="A"?T.text2:T.text4,lineHeight:1.15}}>{partnerEx?.name}</div>
          <div style={{fontSize:12,color:T.text4,marginTop:4}}>
            {partnerEx?.weight!==null&&getW(partnerEx)?`${getW(partnerEx)} kg  ·  `:""}{getR(partnerEx)} reps
          </div>
        </Card>
      )}
      {editTarget&&<DrumEditOverlay target={editTarget} workingWeights={workingWeights} setWW={setWW} workingReps={workingReps} setWR={setWR} block={block} onClose={()=>setEditTarget(null)}/>}
      {showVid&&vidEx&&(
        <div onClick={()=>setShowVid(false)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:24,width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 280ms ${T.ease}`}}>
            <style>{`@keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div><div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{vidEx.name}</div>
              <div style={{fontSize:12,color:T.text3,marginTop:4}}>{vidEx.muscle}</div></div>
              <button onClick={()=>setShowVid(false)} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
            </div>
            <iframe src={`https://www.youtube.com/embed/${vidEx.vid}?autoplay=0&modestbranding=1&rel=0`} style={{width:"100%",aspectRatio:"16/9",border:"none",borderRadius:T.r.md,background:T.bg0,display:"block"}} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen/>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Drum Edit ─────────────────────────────────────────────────────────────────
function DrumEditOverlay({target,workingWeights,setWW,workingReps,setWR,block,onClose}){
  const ex=block.type==="main"?block.ex:(target.exName===block.exA?.name?block.exA:block.exB);
  const initKg  =workingWeights[target.exName]??ex?.weight??0;
  const rawReps =workingReps[target.exName]??ex?.reps;
  const initReps=typeof rawReps==="string"?8:(rawReps??8);
  const [kg,setKg]    =useState(initKg);
  const [reps,setReps]=useState(initReps);
  const hasWeight=ex?.weight!==null&&ex?.weight!==undefined;
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
          <div><div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{target.exName}</div>
          <div style={{fontSize:12,color:T.text3,marginTop:4}}>Scroll to adjust</div></div>
          <button onClick={onClose} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",gap:16,justifyContent:hasWeight?"space-between":"center"}}>
          {hasWeight&&<ScrollDrum value={kg} onChange={setKg} step={1.25} min={0} max={400} label="kg"/>}
          <ScrollDrum value={reps} onChange={setReps} step={1} min={1} max={30} integer label="reps"/>
        </div>
        <button onClick={()=>{
          if(hasWeight) setWW(p=>({...p,[target.exName]:kg}));
          setWR(p=>({...p,[target.exName]:reps}));
          onClose();
        }} style={{marginTop:24,width:"100%",padding:"16px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.strength.glow}`}}>
          Confirm →
        </button>
      </div>
    </div>
  );
}

// ─── Done ──────────────────────────────────────────────────────────────────────
function DoneScreen({profileName,workingWeights,onHome}){
  const nudges=SESSION.blocks.filter(b=>b.type==="main").map(b=>{
    const base=b.ex.weight,current=workingWeights[b.ex.name]??base;
    return{ex:b.ex.name,base,current,changed:current!==base};
  });
  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-120,left:"50%",transform:"translateX(-50%)",width:420,height:380,background:`radial-gradient(circle,${T.strength.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:13,fontWeight:300,fontStyle:"italic",color:T.text3,marginBottom:12}}>{profileName} · Strength A</div>
        <div style={{fontFamily:T.serif,fontSize:42,fontWeight:300,lineHeight:1.1,marginBottom:8}}>
          Session<br/><span style={{color:T.coral,fontStyle:"italic"}}>complete.</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:32,lineHeight:1.6}}>Zone 2 tomorrow. 60 min, easy pace.</p>
      </Fade>
      <Fade d={80}><div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Main lifts</div></Fade>
      {nudges.map((n,i)=>(
        <Fade key={i} d={120+i*60}>
          <Card style={{padding:"16px 20px",marginBottom:10,borderLeft:`2px solid ${n.changed?T.coral:T.bg4}`}}>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>{n.ex}</div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1}}>
              {n.base} kg{n.changed&&<span style={{color:T.coral}}> → {n.current} kg</span>}
            </div>
            <div style={{fontSize:12,marginTop:6,color:n.changed?T.coral:T.text4,fontStyle:"italic",fontFamily:T.serif}}>
              {n.changed?"Weight updated for next session":"Hold — keep grinding"}
            </div>
          </Card>
        </Fade>
      ))}
      <Fade d={260}>
        <button onClick={onHome} style={{marginTop:20,width:"100%",padding:"18px 24px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0,boxShadow:`0 12px 40px ${T.strength.glow}`}}>
          Back to home →
        </button>
      </Fade>
    </div>
  );
}

// ─── Shared ────────────────────────────────────────────────────────────────────
function Fade({children,d=0}){const s=useFadeIn(d);return <div style={s}>{children}</div>;}
function Card({children,style={}}){return <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,...style}}>{children}</div>;}
function Tag({children,color,style={}}){return <span style={{display:"inline-flex",alignItems:"center",fontSize:10,fontWeight:500,color,background:`${color}12`,border:`1px solid ${color}33`,borderRadius:T.r.pill,padding:"4px 12px",letterSpacing:"0.08em",...style}}>{children}</span>;}
function StreakBadge({count}){return(
  <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
    <span style={{fontFamily:T.serif,fontSize:24,fontWeight:400,color:T.gold,lineHeight:1}}>{count||0}</span>
    <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>day<br/>streak</div>
  </div>
);}
