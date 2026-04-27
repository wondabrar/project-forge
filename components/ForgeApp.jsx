"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  WEEK, STRENGTH_DAY_SESSIONS, SESSIONS,
  EXERCISE_POOLS, rotateAccessories, rotationDiff,
  ROTATION_OPTIONAL, ROTATION_AUTO, ROTATION_FORCED,
  DAY_CONFIG, DAY_NAMES, SWAP_DB, EQ_COLOUR,
} from "@/lib/programme";
import {
  LS, P, PB, H, BW, bumpStreak,
  computeRhythm, detectRecoveryPattern,
  blobPush, flushPendingPushes, getLocalProfile, backgroundSync, SyncStatus,
  enableAutoSync, disableAutoSync,
  checkProfileExists, claimProfile, blobDelete,
  roundPlate, applyRpe, weeksSince, weekKey,
  newDraftLog, logSet, finaliseDraft, scaleForReadiness, D, TS,
  inferLoadType, LOAD_TYPES,
} from "@/lib/storage";
import { T } from "@/lib/tokens";
import {
  computeNextPrescription,
  updateLiftStateFromSession,
  updateMuscleAnchorFromSession,
} from "@/lib/progression";
import { getLiftProfile } from "@/lib/lift-translations";
import {
  isWebAuthnSupported, isPlatformAuthenticatorAvailable,
  registerPasskey, authenticatePasskey, hasPasskey,
} from "@/lib/webauthn";
import { track } from "@vercel/analytics";
import PerformanceLab from "@/components/PerformanceLab";
import ErrorBoundary from "@/components/ErrorBoundary";

// ─── Fade hook ─────────────────────────────────────────────────────────────────
function useFadeIn(d=0){
  const [v,setV]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>setV(true),d);return()=>clearTimeout(t);},[d]);
  return{opacity:v?1:0,transform:v?"translateY(0)":"translateY(10px)",
         transition:`opacity 260ms ${T.ease} ${d}ms,transform 260ms ${T.ease} ${d}ms`};
}

// Human-readable "X ago" — tuned for < 12h windows (draft expiry cutoff).
function formatAgo(ms) {
  if (!ms || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return "a while ago";
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

// ─── Sync Status Card ──────────────────────────────────────────────────────────
function SyncStatusCard({ profile }) {
  const [status, setStatus] = useState(SyncStatus.get());
  const [retrying, setRetrying] = useState(false);

  useEffect(() => SyncStatus.subscribe(setStatus), []);

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    await backgroundSync(profile, {
      onUpdate: () => {}, // State is handled by the parent component
    });
    setRetrying(false);
  };

  const formatTime = (ts) => {
    if (!ts) return "never";
    const diff = Date.now() - ts;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  };

  const stateLabel = {
    idle: "Synced",
    pulling: "Syncing...",
    pushing: "Saving...",
    error: "Offline",
  };

  const stateColour = {
    idle: T.sage,
    pulling: T.steel,
    pushing: T.steel,
    error: T.coral,
  };

  return (
    <div style={{
      marginTop: 16,
      padding: "14px 18px",
      background: T.bg2,
      border: `1px solid ${T.bg3}`,
      borderRadius: T.r.lg,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: stateColour[status.state],
          animation: status.state === "pulling" || status.state === "pushing" ? "pulse 1s ease-in-out infinite" : "none",
        }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}>
            {stateLabel[status.state]}
          </div>
          {status.lastSync && status.state === "idle" && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Last sync: {formatTime(status.lastSync)}
            </div>
          )}
          {status.error && (
            <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>
              Will retry when online
            </div>
          )}
        </div>
      </div>
      {status.state === "error" && (
        <button
          onClick={handleRetry}
          disabled={retrying}
          style={{
            padding: "8px 14px",
            background: T.bg3,
            border: `1px solid ${T.bg4}`,
            borderRadius: T.r.md,
            fontSize: 12,
            fontWeight: 500,
            color: T.text2,
            cursor: retrying ? "default" : "pointer",
            opacity: retrying ? 0.6 : 1,
          }}
        >
          {retrying ? "..." : "Retry"}
        </button>
      )}
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function ForgeApp(){
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);

  const [activeProfile,setActiveProfileState]=useState(()=>typeof window!=="undefined"?P.getActive():null);
  const [showProfiles,setShowProfiles]=useState(false);
  const [streak,setStreak]=useState(0); // retained for compat — now derived from history, see useMemo below
  const [screen,setScreen]=useState(()=>{
    if (typeof window === "undefined") return "home";
    return LS.get("forge:onboarded", false) ? "home" : "onboarding";
  });
  const [activeSessionIdx,setActiveSessionIdx]=useState(0);
  const [sessionSwaps,setSessionSwaps]=useState({});
  const [programmeBlock,setProgrammeBlock]=useState(()=>PB.get());
  const [weekDone,setWeekDone]=useState({});
  const [blockIdx,setBlockIdx]=useState(0);
  const [setNum,setSetNum]=useState(1);
  const [phase,setPhase]=useState("A");
  const [readiness,setReadiness]=useState(null);
  const [readinessReason,setReadinessReason]=useState(null);
  const [showVid,setShowVid]=useState(false);
  const [editTarget,setEditTarget]=useState(null);
  const [awaitRpe,setAwaitRpe]=useState(false);
  const [ssRoundDone,setSsRoundDone]=useState(false);
  const [workingWeights,setWWState]=useState({});
  const [workingReps,setWRState]=useState({});
  const [restActive,setRestActive]=useState(false);
  const [restRemain,setRestRemain]=useState(180);
  const [restTrigger,setRestTrigger]=useState(null);
  // Append-only session log built during an active session
  const draftLogRef = useRef(null);
  // Shown when auto-rotation fires — acknowledge before starting session
  const [rotationSummary,setRotationSummary]=useState(null);
  // Full session history — loaded from localStorage, merged from blob
  const [history,setHistory]=useState([]);
  // Anti-dysmorphia: dismiss-once-per-render for recovery nudge
  const [recoveryDismissed,setRecoveryDismissed]=useState(false);
  // PWA install prompt (iOS needs custom UI; Android gets the OS prompt for free)
  const [showIosInstall,setShowIosInstall]=useState(false);
  // Sync status for subtle UI indicator
  const [syncState,setSyncState]=useState("idle"); // "idle" | "pulling" | "pushing" | "error"
  // In-flight draft from a prior, interrupted session — shown as a resume card on home
  const [pendingDraft,setPendingDraft]=useState(null); // { draft, ageMs, setCount } | null
  // Bodyweight state — loaded from BW helper, used for bodyweight movements
  const [bodyweight,setBodyweightState]=useState(null); // current BW in kg or null
  const [bwIsStale,setBwIsStale]=useState(false); // true if BW > 14 days old or never set
  const [bwCardDismissed,setBwCardDismissed]=useState(false); // in-memory dismiss for this session
  const [bwEditOpen,setBwEditOpen]=useState(false); // BW edit modal state
  const [bwPromptedThisSession,setBwPromptedThisSession]=useState(false); // only prompt once per session

  // Subscribe to sync status changes
  useEffect(() => {
    return SyncStatus.subscribe(status => setSyncState(status.state));
  }, []);

  // Rhythm — derived from history, no persistence needed
  const rhythm = useMemo(() => computeRhythm(history), [history]);
  const recoveryNudge = useMemo(
    () => (recoveryDismissed ? null : detectRecoveryPattern(history)),
    [history, recoveryDismissed]
  );

  // Seed on profile change: instant load from localStorage, background sync from blob
  useEffect(()=>{
    if(!activeProfile) return;
    
    // INSTANT: Load from localStorage (0ms, works offline)
    const local = getLocalProfile(activeProfile);
    setWWState(local.meta.weights || {});
    setWRState(local.meta.reps || {});
    setStreak(local.meta.streak?.count || 0);
    setProgrammeBlock(local.meta.programmeBlock || PB.get());
    setWeekDone(P.getWeekDone(activeProfile));
    setHistory(local.history || []);

    // Retry any failed pushes from previous sessions
    flushPendingPushes((profile) => ({
      meta: {
        weights: P.getWeights(profile),
        reps: P.getReps(profile),
        streak: P.getStreak(profile),
        programmeBlock: PB.get(),
      },
      history: H.get(profile),
    }));

    // BACKGROUND: Sync from blob, update state if remote has newer data
    const onSyncUpdate = ({ meta, history: remoteHistory }) => {
      // Blob had newer data — update React state silently
      if (meta.weights) setWWState(meta.weights);
      if (meta.reps) setWRState(meta.reps);
      if (meta.streak?.count) setStreak(meta.streak.count);
      if (meta.programmeBlock) setProgrammeBlock(meta.programmeBlock);
      if (remoteHistory?.length) setHistory(remoteHistory);
    };
    
    backgroundSync(activeProfile, { onUpdate: onSyncUpdate });
    
    // Enable auto-sync on visibility change and online events
    enableAutoSync(activeProfile, onSyncUpdate);

    // Check for an interrupted session — surfaces as a resume card on home
    const interrupted = D.load(activeProfile);
    setPendingDraft(interrupted);

    // Load bodyweight state
    const bw = BW.getKg(activeProfile);
    setBodyweightState(bw);
    setBwIsStale(BW.isStale(activeProfile));

    return () => disableAutoSync();
  },[activeProfile]);

  // Rest timer tick
  useEffect(()=>{
    if(!restActive) return;
    if(restRemain<=0){
      setRestActive(false);
      // Haptic: Android fires; iOS Safari silently no-ops (returns false).
      // Wrapped defensively — some browsers throw on invocation without
      // a prior user gesture (shouldn't happen here since timer started
      // from a button tap, but belt-and-braces).
      try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(200); } catch {}
      return;
    }
    const t=setTimeout(()=>setRestRemain(p=>p-1),1000);
    return()=>clearTimeout(t);
  },[restActive,restRemain]);

  // PWA install prompt — iOS needs a custom overlay because Safari has no
  // beforeinstallprompt event. Android/Chrome handles this natively via
  // the manifest, so we only target iOS Safari here.
  //
  // Trigger rule: after the user has completed ≥1 session and isn't already
  // installed. Shown once, dismissable, remembered via localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!activeProfile) return;

    // Already dismissed in the past? Leave it alone.
    if (LS.get("forge:iosInstallDismissed", false)) return;

    // Not on iOS? Android handles the prompt natively via the manifest.
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    if (!isIOS) return;

    // Already installed (launched from home screen)?
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (isStandalone) return;

    // Gate on ≥1 completed session — don't nag new visitors
    if (history.length < 1) return;

    // Let the user settle on home for a beat before surfacing
    const t = setTimeout(() => setShowIosInstall(true), 1200);
    return () => clearTimeout(t);
  }, [activeProfile, history.length]);

  useEffect(()=>{
    if(!restTrigger) return;
    setRestRemain(restTrigger.duration);
    setRestActive(true);
  },[restTrigger]);

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

  const updateBodyweight = useCallback((kg) => {
    if (!activeProfile || !kg) return;
    BW.set(activeProfile, kg);
    setBodyweightState(kg);
    setBwIsStale(false);
  }, [activeProfile]);

  const activateProfile = async (name, { claim = false } = {}) => {
    const trimmed = String(name).trim();
    if (!trimmed) return { ok: false, reason: "empty" };

    // Claim path: first-time signup for a new name.
    // The claim endpoint is atomic — if someone else grabbed the name
    // between the availability check and now, we'll get 409 here.
    if (claim) {
      const result = await claimProfile(trimmed, trimmed);
      if (result.taken) return { ok: false, reason: "taken" };
      if (!result.ok)   return { ok: false, reason: "network" };
    }

    P.add(trimmed);
    P.setActive(trimmed);
    setActiveProfileState(trimmed);
    setShowProfiles(false);
    return { ok: true };
  };

  // Scale session by readiness (cooked = 85% weight on mains, -1 set supersets, no finishers)
  const rawSession = SESSIONS[activeSessionIdx];
  const activeSession = useMemo(
    () => scaleForReadiness(rawSession, readiness),
    [rawSession, readiness]
  );
  const block    = activeSession.blocks[blockIdx];
  const isSS     = block.type==="superset"||block.type==="finisher";
  const swapKey  = isSS ? `${block.id}-${phase}` : block.id;

  // Single source of truth for exercise resolution:
  // manual in-session swap → rotation config → programme default
  const resolveExFn = useCallback((blockId, ph, defaultEx) => {
    const key = ph ? `${blockId}-${ph}` : blockId;
    return sessionSwaps[key] ?? programmeBlock.config[key] ?? defaultEx;
  }, [sessionSwaps, programmeBlock]);

  // Pre-resolve both sides of the current block so SessionScreen
  // never needs to touch block.exA/exB directly
  const resolvedExA = isSS ? resolveExFn(block.id, "A", block.exA) : null;
  const resolvedExB = isSS ? resolveExFn(block.id, "B", block.exB) : null;
  const resolvedEx  = !isSS ? resolveExFn(block.id, null, block.ex) : null;
  const activeEx    = isSS ? (phase==="A" ? resolvedExA : resolvedExB) : resolvedEx;

  const getW=useCallback((ex)=>ex?(workingWeights[ex.name]??ex.weight):null,[workingWeights]);
  const getR=useCallback((ex)=>ex?(workingReps[ex.name]??ex.reps):null,[workingReps]);

  const onSwap=useCallback((key, newEx)=>{
    setSessionSwaps(prev=>({...prev,[key]:newEx}));
  },[]);

  // Append one set to the draft log. Tolerant of missing draft (mid-session recovery).
  // Phase is derived from the exercise identity — critical for supersets where
  // commitLog fires after phase has already moved, and we need both A and B
  // logged against the correct slot keys.
  const pushSetToDraft = useCallback((ex, rpe) => {
    if (!draftLogRef.current || !ex) return;
    let key = block.id;
    if (isSS) {
      // Match the exercise against the resolved A/B to determine its slot
      const resolvedA = resolveExFn(block.id, "A", block.exA);
      const resolvedB = resolveExFn(block.id, "B", block.exB);
      const derivedPhase = ex.name === resolvedA?.name ? "A"
                         : ex.name === resolvedB?.name ? "B"
                         : phase; // fallback for edge cases
      key = `${block.id}-${derivedPhase}`;
    }
    const swapPick = sessionSwaps[key];
    const swapped  = !!swapPick;
    const fromPool = EXERCISE_POOLS[key] ? key : null;
    const loadType = ex.loadType || inferLoadType(ex.name);
    logSet(draftLogRef.current, {
      blockId: block.id,
      blockType: block.type,
      exerciseName: ex.name,
      muscle: ex.muscle,
      swapped,
      fromPool,
      loadType,
      bodyweight: bodyweight,
      weight: workingWeights[ex.name] ?? ex.weight,
      reps: workingReps[ex.name] ?? ex.reps,
      rpe: rpe || null,
    });
    // Persist the draft to LS so a force-quit or crash doesn't lose work.
    // LS-only on purpose — blob isn't chatty-enough-reliable for this.
    D.save(activeProfile, draftLogRef.current);
    
    // If this is a bodyweight movement and user hasn't set BW, prompt once per session
    if (loadType !== "external" && bodyweight === null && !bwPromptedThisSession) {
      setBwPromptedThisSession(true);
      // Delay slightly so the RPE card shows first
      setTimeout(() => setBwEditOpen(true), 600);
    }
  }, [block, isSS, phase, sessionSwaps, workingWeights, workingReps, resolveExFn, activeProfile, bodyweight, bwPromptedThisSession]);

  const commitLog=useCallback((rpe)=>{
    // Use resolved exercises so RPE weight adjustments target the correct name
    const exes = isSS
      ? [resolveExFn(block.id,"A",block.exA), resolveExFn(block.id,"B",block.exB)]
      : [resolveExFn(block.id, null, block.ex)];

    // Record the actual sets performed in the draft log. Per-block weight
    // adjustments via applyRpe used to fire here, but Phase 2 moves all
    // progression decisions to the session-finalise hook (better — engine
    // sees the entire session's performance against prescribed targets,
    // not just one block).
    exes.forEach(ex => pushSetToDraft(ex, rpe));

    // Advance block / set / screen
    if(setNum>=block.sets){
      if(blockIdx<activeSession.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
      else setScreen("done");
    }else setSetNum(p=>p+1);
    setRestTrigger({id:Date.now(),duration:block.rest});
    setSsRoundDone(false);
    setAwaitRpe(false);
  },[block,blockIdx,isSS,setNum,activeSession,resolveExFn,pushSetToDraft]);

  const handleLog=useCallback(()=>{
    if(isSS){
      if(phase==="A"){
        // Log exercise A as we move into B. Only for finishers — supersets
        // will log both A and B together in commitLog when RPE is submitted.
        if(block.type==="finisher"){
          pushSetToDraft(resolveExFn(block.id,"A",block.exA), null);
        }
        setPhase("B");return;
      }
      setPhase("A");
      if(block.type==="superset"){setSsRoundDone(true);return;}
      // Finisher: log B, then advance silently without RPE
      pushSetToDraft(resolveExFn(block.id,"B",block.exB), null);
      if(setNum>=block.sets){
        if(blockIdx<activeSession.blocks.length-1){setBlockIdx(p=>p+1);setSetNum(1);setPhase("A");}
        else setScreen("done");
      }else setSetNum(p=>p+1);
      setRestTrigger({id:Date.now(),duration:block.rest});
      return;
    }
    setAwaitRpe(true);
  },[block,blockIdx,isSS,phase,setNum,activeSession,resolveExFn,pushSetToDraft]);

  const reset=()=>{
    setBlockIdx(0);setSetNum(1);setPhase("A");setReadiness(null);setReadinessReason(null);
    setAwaitRpe(false);setSsRoundDone(false);
    setRestActive(false);setRestRemain(180);setRestTrigger(null);
    setSessionSwaps({});
    draftLogRef.current = null;
    // If the user explicitly quits, the pending-draft card should go too.
    D.clear(activeProfile);
    setPendingDraft(null);
    setScreen("home");
  };

  useEffect(()=>{
    if(screen==="done"&&activeProfile){
      const newStreak=bumpStreak(activeProfile);
      setStreak(newStreak);
      // Mark today as done in the week strip
      const dw=new Date().getDay();
      const wm=[6,0,1,2,3,4,5];
      const updated=P.markDayDone(activeProfile,wm[dw]);
      setWeekDone(updated);

      // Finalise the session draft and append to history
      let sessionRecord = null;
      if (draftLogRef.current) {
        sessionRecord = finaliseDraft(draftLogRef.current);
        H.append(activeProfile, sessionRecord);
        // Reflect in React state so Performance Lab updates immediately
        setHistory(H.get(activeProfile));
        draftLogRef.current = null;
      }
      // Completed session — drop the persisted draft.
      D.clear(activeProfile);
      setPendingDraft(null);

      // ─── Phase 2: progression engine ──────────────────────────────────
      // For every exercise in the just-finished session, compute next
      // prescription, update lift state + muscle anchors, and write the
      // new working weight back to setWW so future sessions pick it up.
      // Engine is silent — user sees a quietly smarter app.
      if (sessionRecord) {
        try {
          const fullHistory = H.get(activeProfile); // already includes the new record
          const trainingState = TS.get(activeProfile);
          const wwUpdates = {};

          for (const block of sessionRecord.blocks || []) {
            for (const ex of block.exercises || []) {
              const liftState = trainingState.lifts?.[ex.name] || null;
              const profile = getLiftProfile(ex.name);
              const anchorMuscle = profile.primaryMuscle;
              const muscleAnchor = anchorMuscle
                ? trainingState.muscleAnchors?.[anchorMuscle] || null
                : null;

              const prescription = computeNextPrescription({
                liftName: ex.name,
                history: fullHistory,
                liftState,
                muscleAnchor,
                context: {
                  readiness: sessionRecord.readiness,
                  currentWeight: workingWeights[ex.name] ?? ex.sets?.[0]?.weight ?? null,
                },
              });

              // Update working weights for next session — only when engine
              // returned a numeric weight (BW lifts return null).
              if (prescription.weight !== null && prescription.weight !== undefined) {
                wwUpdates[ex.name] = prescription.weight;
              }

              // Persist updated lift state
              const newLiftState = updateLiftStateFromSession(
                liftState,
                sessionRecord,
                ex,
                prescription,
              );
              TS.updateLift(activeProfile, ex.name, newLiftState);

              // Update muscle anchor — only for loaded lifts with a known muscle group.
              // Anchor tracks the strongest implied muscle-group strength across all lifts.
              if (anchorMuscle && profile.progressesByLoad) {
                const currentAnchor = TS.get(activeProfile).muscleAnchors?.[anchorMuscle] || null;
                const newAnchor = updateMuscleAnchorFromSession(currentAnchor, sessionRecord, ex);
                if (newAnchor) TS.updateMuscleAnchor(activeProfile, anchorMuscle, newAnchor);
              }
            }
          }

          if (Object.keys(wwUpdates).length) {
            setWW(p => ({ ...p, ...wwUpdates }));
          }
        } catch (e) {
          // Engine errors must never block session completion.
          console.error("[forge:progression]", e);
        }
      }
      // ──────────────────────────────────────────────────────────────────

      // Anonymous completion signal — feeds Vercel Analytics funnel.
      // No PII, no free-text; enum-only dimensions.
      try {
        track("session_complete", {
          session: sessionRecord?.session || "strength",
          readiness: readiness || "normal",
          readinessReason: readinessReason || "unspecified",
          block: String(programmeBlock?.number ?? 1),
        });
      } catch {}

      // Push both meta and the just-finalised record to blob.
      // History push is incremental — only this one record, the server
      // merges with whatever it has.
      blobPush(activeProfile, {
        meta: {
          weights: workingWeights,
          reps: workingReps,
          streak: P.getStreak(activeProfile),
          programmeBlock,
        },
        history: sessionRecord ? [sessionRecord] : [],
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[screen==="done"]);

  // Mark a non-strength day complete (zone 2, cardio, HIIT, rest)
  const handleMarkDayDone = useCallback(()=>{
    if(!activeProfile) return;
    const dw=new Date().getDay();
    const wm=[6,0,1,2,3,4,5];
    const idx=wm[dw];
    const updated=P.markDayDone(activeProfile,idx);
    setWeekDone(updated);
    const newStreak=bumpStreak(activeProfile);
    setStreak(newStreak);
  },[activeProfile]);

  if(!mounted) return null;

  // Onboarding — first-time intro, shown before ProfileScreen
  if(screen==="onboarding"){
    return <OnboardingScreen onContinue={()=>{
      LS.set("forge:onboarded", true);
      setScreen("home");
    }}/>;
  }

  if(!activeProfile||showProfiles){
  return <ProfileScreen existing={P.list()} current={activeProfile} onActivate={activateProfile} onCancel={showProfiles?()=>setShowProfiles(false):null} bodyweight={bodyweight} bwEditOpen={bwEditOpen} setBwEditOpen={setBwEditOpen} updateBodyweight={updateBodyweight}/>;
  }

const sProps={
  session:activeSession,
  block,blockIdx,totalBlocks:activeSession.blocks.length,setNum,phase,isSS,
  activeEx, resolvedExA, resolvedExB, resolvedEx,
  swapKey,onSwap,
  showVid,setShowVid,getW,getR,editTarget,setEditTarget,
  workingWeights,setWW,workingReps,setWR,
  awaitRpe,ssRoundDone,
  restActive,restRemain,setRestActive,setRestRemain,
  onCommit:commitLog,onLog:handleLog,onQuit:reset,
  bodyweight,
  };

  // Derive today's session index for HomeScreen
  const dow      = new Date().getDay();
  const weekMap  = [6,0,1,2,3,4,5];
  const todayIdx = weekMap[dow];
  const todaySessionIdx = STRENGTH_DAY_SESSIONS[todayIdx] ?? 0;

  // Actually rotate. Returns the new block so we can compute the diff.
  const rotate = (showSummary = false) => {
    const oldConfig = programmeBlock.config;
    const history = {};
    Object.entries(oldConfig).forEach(([k,ex])=>{ history[k]=ex.name; });
    const newConfig = rotateAccessories(history);
    const next = {
      number: programmeBlock.number + 1,
      startDate: new Date().toISOString().slice(0,10),
      config: newConfig,
      history,
    };
    setProgrammeBlock(next);
    PB.save(next);
    if (showSummary) {
      const changes = rotationDiff(oldConfig, newConfig);
      setRotationSummary({ blockNumber: next.number, changes });
    }
    return next;
  };

  const handleRotate = () => rotate(true);

  const beginSession = () => {
    // Auto-rotate if we're past the threshold. Show summary card;
    // once acknowledged, readiness screen follows.
    const weeks = weeksSince(programmeBlock.startDate);
    if (weeks >= ROTATION_AUTO) {
      rotate(true);
      // The summary modal's continue button transitions to readiness
      setActiveSessionIdx(todaySessionIdx);
      return;
    }
    setActiveSessionIdx(todaySessionIdx);
    setScreen("readiness");
  };

  // After rotation summary acknowledged, advance to readiness
  const handleRotationContinue = () => {
    setRotationSummary(null);
    setScreen("readiness");
  };

  // Readiness screen's "start" initialises the draft log and enters session
  const handleReadinessStart = () => {
    draftLogRef.current = newDraftLog({
      profileName: activeProfile,
      session: ["strength-a","strength-b","strength-c"][activeSessionIdx],
      blockNumber: programmeBlock.number,
      readiness,
      readinessReason,
    });
    setScreen("session");
  };

  // Resume a draft from a previous, interrupted session.
  // Jumps straight into session screen at the furthest block the user reached.
  const handleResumeDraft = () => {
    if (!pendingDraft) return;
    const { draft } = pendingDraft;

    // Rehydrate readiness / session selection from the saved draft so the
    // working-set path resolves correctly.
    const sessionKey = draft.session; // "strength-a" | ...
    const idx = ["strength-a","strength-b","strength-c"].indexOf(sessionKey);
    if (idx === -1) { handleDiscardDraft(); return; }

    // Map back to the live SESSIONS definition. If programme has rotated since
    // the draft was saved, the draft's block ids should still match by id.
    const session = SESSIONS[idx];
    if (!session) { handleDiscardDraft(); return; }

    // Find which block they reached — the highest-indexed block with any sets.
    let resumeBlockIdx = 0;
    let setsOnCurrent  = 0;
    for (let i = 0; i < session.blocks.length; i++) {
      const saved = draft.blocks[session.blocks[i].id];
      if (!saved) continue;
      const setsHere = Object.values(saved.exercises || {})
        .reduce((n, ex) => n + (ex.sets || []).length, 0);
      if (setsHere > 0) {
        resumeBlockIdx = i;
        // For non-superset, sets-per-exercise == setNum-1 completed
        // For superset, we log both A+B together, so pairs == setNum-1
        const block = session.blocks[i];
        const isSS = block.type === "superset" || block.type === "finisher";
        const pairs = Math.max(
          ...Object.values(saved.exercises || {}).map(ex => (ex.sets || []).length)
        );
        setsOnCurrent = isSS ? pairs : pairs; // both resolve the same way here
      }
    }

    // Hydrate React state and re-attach the draft ref
    draftLogRef.current = draft;
    setActiveSessionIdx(idx);
    setReadiness(draft.readiness);
    setReadinessReason(draft.readinessReason);
    setBlockIdx(resumeBlockIdx);
    // Resume AT the next set (what they'd have logged next)
    setSetNum(Math.min(setsOnCurrent + 1, session.blocks[resumeBlockIdx].sets));
    setPhase("A");
    setPendingDraft(null);
    setScreen("session");
  };

  const handleDiscardDraft = () => {
    D.clear(activeProfile);
    setPendingDraft(null);
  };

  const weeksOnBlock = weeksSince(programmeBlock.startDate);

  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased"}}>
      {screen==="home"        && <HomeScreen rhythm={rhythm} profileName={activeProfile} onBegin={beginSession} onProfile={()=>setShowProfiles(true)} weekDone={weekDone} onMarkDayDone={handleMarkDayDone} programmeBlock={programmeBlock} weeksOnBlock={weeksOnBlock} onRotate={handleRotate} onPerformance={()=>setScreen("performance")} historyCount={history.length} recoveryNudge={recoveryNudge} onDismissRecovery={()=>setRecoveryDismissed(true)} syncState={syncState} pendingDraft={pendingDraft} onResumeDraft={handleResumeDraft} onDiscardDraft={handleDiscardDraft} showBwCard={bwIsStale && !bwCardDismissed} onOpenBwEdit={()=>setBwEditOpen(true)} onDismissBwCard={()=>setBwCardDismissed(true)}/>}
      {screen==="readiness"   && <ReadinessScreen readiness={readiness} setReadiness={setReadiness} reason={readinessReason} setReason={setReadinessReason} onStart={handleReadinessStart}/>}
      {screen==="session"     && <ErrorBoundary><SessionScreen {...sProps}/></ErrorBoundary>}
      {screen==="done"        && <ErrorBoundary><DoneScreen session={activeSession} profileName={activeProfile} workingWeights={workingWeights} onHome={reset}/></ErrorBoundary>}
      {screen==="performance" && <ErrorBoundary><PerformanceLab history={history} onBack={()=>setScreen("home")}/></ErrorBoundary>}
      {rotationSummary        && <RotationSummaryModal summary={rotationSummary} onContinue={handleRotationContinue}/>}
      {showIosInstall         && <IosInstallOverlay onDismiss={()=>{ LS.set("forge:iosInstallDismissed", true); setShowIosInstall(false); }}/>}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
    </div>
  );
}

// ─── Taken Name Modal ──────────────────────────────────────────────────────────
// Shows when user tries to claim a name that exists — offers passkey sign-in if available
function TakenNameModal({ name, webAuthnSupported, onClose, onActivate, passkeyBusy, setPasskeyBusy, passkeyError, setPasskeyError }) {
  const [hasProfilePasskey, setHasProfilePasskey] = useState(null); // null = checking
  const [authSuccess, setAuthSuccess] = useState(false);

  // Check if this profile has a passkey
  useEffect(() => {
    hasPasskey(name).then(setHasProfilePasskey);
  }, [name]);

  const handlePasskeySignIn = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(name);
      if (result?.verified) {
        setAuthSuccess(true);
        // Add profile locally and activate, then call onActivate to update React state
        P.add(name);
        P.setActive(name);
        // Give user a moment to see success state, then activate properly
        setTimeout(() => {
          onActivate(name, { claim: false });
        }, 800);
      } else {
        setPasskeyError("Authentication cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  if (authSuccess) {
    return (
      <div style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div style={{background:T.bg2,borderRadius:T.r.xl,padding:"40px 32px",textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:16}}>✓</div>
          <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text1}}>
            Welcome back, {name}
          </div>
          <p style={{fontSize:13,color:T.text3,marginTop:8}}>Loading your data...</p>
        </div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 260ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box",position:"relative"}}>
        <button onClick={onClose} aria-label="Close" style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Is this you?
        </div>
        <div style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:12}}>
          {hasProfilePasskey === null ? "Checking..." : hasProfilePasskey ? "Sign in with passkey" : "Signing in on a new device"}
        </div>

        {/* If profile has passkey and WebAuthn is supported, show sign-in option */}
        {webAuthnSupported && hasProfilePasskey && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is secured with a passkey. Use Face ID, Touch ID, or your device PIN to sign in.
            </p>

            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}

            <button
              onClick={handlePasskeySignIn}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.coral,
                border:"none",
                borderRadius:T.r.lg,
                fontSize:16,
                fontWeight:500,
                color:T.bg0,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:16,
              }}
            >
              {passkeyBusy ? "Verifying..." : "Sign in with passkey"}
            </button>

            <p style={{fontSize:11,color:T.text4,textAlign:"center",lineHeight:1.5}}>
              Lost access to your passkey? Contact support to recover your account.
            </p>
          </>
        )}

        {/* Fallback: no passkey or WebAuthn not supported */}
        {(!webAuthnSupported || hasProfilePasskey === false) && hasProfilePasskey !== null && (
          <>
            <p style={{fontSize:13,color:T.text2,marginBottom:22,lineHeight:1.6}}>
              <span style={{color:T.text1}}>{name}</span> is claimed but doesn&apos;t have a passkey set up. You&apos;ll need to wipe it from the original device to reclaim it here.
            </p>

            <div style={{padding:"14px 16px",borderRadius:T.r.md,background:`${T.gold}0E`,border:`1px solid ${T.gold}33`,marginBottom:22}}>
              <div style={{fontSize:10,fontWeight:500,color:T.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                What to do
              </div>
              <p style={{fontSize:13,color:T.text1,lineHeight:1.55}}>
                On your old device: tap your name → <span style={{fontStyle:"italic",fontFamily:T.serif}}>Full wipe</span>. That releases the name so you can claim it here.
              </p>
            </div>

            <button onClick={onClose} style={{width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text2}}>
              Got it
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Onboarding Screen ────────────────────────────────────────────────────────
// First-time intro. Sets forge:onboarded on continue so returning visitors
// skip straight to ProfileScreen or home. BW is collected after name entry.
function OnboardingScreen({ onContinue }) {
  const { strength: s } = T;

  return (
    <div style={{
      background: T.bg0, minHeight: "100vh", maxWidth: 430, margin: "0 auto",
      fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
      padding: "72px 24px 48px", position: "relative", overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
      {/* Ambient glow */}
      <div style={{
        position: "absolute", top: -160, left: "50%", transform: "translateX(-50%)",
        width: 500, height: 440,
        background: `radial-gradient(ellipse, ${s.glow} 0%, transparent 65%)`,
        pointerEvents: "none",
      }}/>

      <Fade d={0}>
        <div style={{
          fontSize: 11, fontWeight: 500, color: T.coral,
          letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
        }}>
          Forge
        </div>
        <div style={{ fontFamily: T.serif, fontSize: 44, fontWeight: 300, lineHeight: 1.1, marginBottom: 16 }}>
          Train with<br/><span style={{ fontStyle: "italic", color: T.coral }}>intention.</span>
        </div>
      </Fade>

      <Fade d={120}>
        <p style={{ fontSize: 15, color: T.text2, lineHeight: 1.65, marginBottom: 28 }}>
          A lean strength tracker. Three sessions a week, the right lifts, and a timer that minds its own business.
        </p>
      </Fade>

      {/* The three promises — feel like editorial callouts rather than feature bullets */}
      <Fade d={200}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginBottom: 32 }}>
          <PromiseLine
            accent={T.coral}
            kicker="Strength"
            body="Three sessions a week. Squat, hinge, push, pull. Your weights adapt to how you felt last time."
          />
          <PromiseLine
            accent={T.steel}
            kicker="Conditioning"
            body="Zone 2 and HIIT days baked in. Because a strong heart matters as much as a strong back."
          />
          <PromiseLine
            accent={T.sage}
            kicker="Yours"
            body="No accounts, no email, no bullshit. Your name, a passkey, and you're in."
          />
        </div>
      </Fade>

      <div style={{ flex: 1 }}/>

      <Fade d={320}>
        <button onClick={() => onContinue()} style={{
          width: "100%", padding: "18px 24px",
          background: T.coral, border: "none", borderRadius: T.r.lg, cursor: "pointer",
          fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
          boxShadow: `0 12px 40px ${s.glow}`,
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span>Let's go</span>
          <span style={{ fontSize: 18 }}>→</span>
        </button>
      </Fade>
    </div>
  );
}

function PromiseLine({ accent, kicker, body }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={{
        width: 3, alignSelf: "stretch", minHeight: 48,
        borderRadius: 2, background: accent, flexShrink: 0, marginTop: 2,
      }}/>
      <div>
        <div style={{
          fontSize: 10, fontWeight: 500, color: accent,
          letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 5,
        }}>
          {kicker}
        </div>
        <div style={{ fontSize: 14, color: T.text1, lineHeight: 1.55 }}>
          {body}
        </div>
      </div>
    </div>
  );
}

// ─── Profile Screen ────────────────────────────────────────────────────────────
function ProfileScreen({existing,current,onActivate,onCancel,bodyweight=null,bwEditOpen=false,setBwEditOpen,updateBodyweight}){
  const [name,setName]=useState("");
  const [confirmWipe,setConfirmWipe]=useState(null);
  const [showTakenHelp,setShowTakenHelp]=useState(false);
  // availability: "idle" | "checking" | "available" | "taken" | "network-err"
  const [availability,setAvailability]=useState("idle");
  const [submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState(null);
  const checkTimerRef = useRef(null);
  const latestQueryRef = useRef("");
  const {strength:s}=T;

  // Post-claim BW step (only for new users with no existing profiles)
  const [showBwStep, setShowBwStep] = useState(false);
  const [pendingBw, setPendingBw] = useState(75);
  const [claimedName, setClaimedName] = useState(null);

  // Passkey state
  const [webAuthnSupported, setWebAuthnSupported] = useState(false);
  const [showPasskeySetup, setShowPasskeySetup] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState(null);
  const [profileHasPasskey, setProfileHasPasskey] = useState({});
  const [authToken, setAuthToken] = useState(null); // For authenticated destructive ops
  const [needsPasskeyAuth, setNeedsPasskeyAuth] = useState(null); // Profile name requiring auth

  // Check WebAuthn support on mount
  useEffect(() => {
    isPlatformAuthenticatorAvailable().then(setWebAuthnSupported);
  }, []);

  // Check if each profile has a passkey (only on mount, not when state changes)
  // Using a ref to track which profiles we've already checked
  const checkedProfilesRef = useRef(new Set());
  useEffect(() => {
    // Check all existing profiles we haven't checked yet
    existing.forEach(async (profile) => {
      if (checkedProfilesRef.current.has(profile)) return;
      checkedProfilesRef.current.add(profile);
      const has = await hasPasskey(profile);
      // Only update if not already true (preserves local registration state)
      setProfileHasPasskey(prev => prev[profile] === true ? prev : { ...prev, [profile]: has });
    });
    // Also explicitly check current profile if not checked
    if (current && !checkedProfilesRef.current.has(current)) {
      checkedProfilesRef.current.add(current);
      hasPasskey(current).then(has => {
        setProfileHasPasskey(prev => prev[current] === true ? prev : { ...prev, [current]: has });
      });
    }
  }, [existing, current]);

  // Expanded wipe: opts.cloud === true also nukes cloud data via DELETE /api/sync.
  // opts.cloud === false only clears local storage (fast, offline-safe).
  const [wipeBusy,setWipeBusy]=useState(false);
  const [wipeError,setWipeError]=useState(null);
  const wipeProfile=async (n,{cloud=false}={})=>{
    setWipeError(null);
    setWipeBusy(true);
    if (cloud) {
      const result = await blobDelete(n, { authToken });
      if (!result.ok) {
        setWipeBusy(false);
        if (result.requiresAuth) {
          setConfirmWipe(null);
          setNeedsPasskeyAuth(n);
          return;
        }
        setWipeError(result.error || "Couldn't reach the cloud. Try again?");
        return;
      }
    }
    // Local cleanup always runs regardless of cloud branch
    ["weights","reps","streak","history","pendingPushes"].forEach(k=>localStorage.removeItem(`forge:${n}:${k}`));
    const updated=P.list().filter(p=>p!==n);
    LS.set("forge:profiles",updated);
    if(P.getActive()===n){ LS.set("forge:active",null); }
    setWipeBusy(false);
    setConfirmWipe(null);
    setAuthToken(null);
    window.location.reload();
  };

  // Handle passkey authentication for destructive ops
  const handlePasskeyAuth = async () => {
    if (!needsPasskeyAuth) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await authenticatePasskey(needsPasskeyAuth);
      if (result?.verified && result?.authToken) {
        setAuthToken(result.authToken);
        setNeedsPasskeyAuth(null);
        // Now retry the wipe with the token
        setConfirmWipe(needsPasskeyAuth);
      } else {
        setPasskeyError("Authentication cancelled or failed");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey authentication failed");
    }
    setPasskeyBusy(false);
  };

  // Register a passkey for the current profile
  const handleRegisterPasskey = async () => {
    if (!current) return;
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const result = await registerPasskey(current);
      if (result?.ok) {
        // Update local state immediately - don't wait for async check
        setProfileHasPasskey(prev => ({ ...prev, [current]: true }));
        setShowPasskeySetup(false);
        setPasskeyError(null);
      } else if (result === null) {
        // User cancelled - not an error, just close
        setPasskeyError(null);
      } else {
        setPasskeyError("Setup cancelled");
      }
    } catch (e) {
      setPasskeyError(e.message || "Passkey setup failed");
    }
    setPasskeyBusy(false);
  };

  // Debounced availability check as user types
  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) {
      setAvailability("idle");
      clearTimeout(checkTimerRef.current);
      return;
    }
    // If it's an existing local profile, it's "ours" — treat as available
    if (existing.some(e => e.toLowerCase() === trimmed.toLowerCase())) {
      setAvailability("available");
      return;
    }
    setAvailability("checking");
    clearTimeout(checkTimerRef.current);
    latestQueryRef.current = trimmed;
    checkTimerRef.current = setTimeout(async () => {
      const res = await checkProfileExists(trimmed);
      // Guard against stale responses — user may have typed more since
      if (latestQueryRef.current !== trimmed) return;
      if (res === null) setAvailability("network-err");
      else if (res.exists) setAvailability("taken");
      else setAvailability("available");
    }, 400);
    return () => clearTimeout(checkTimerRef.current);
  }, [name, existing]);

  const canSubmit = name.trim().length >= 2 && (availability === "available" || availability === "network-err") && !submitting;

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    // If it's an existing local profile, just activate — don't try to claim again
    const isLocalProfile = existing.some(e => e.toLowerCase() === trimmed.toLowerCase());
    const result = await onActivate(trimmed, { claim: !isLocalProfile });
    setSubmitting(false);
    if (!result?.ok) {
      if (result?.reason === "taken") {
        setAvailability("taken");
        setSubmitError("Someone just claimed that name. Try another.");
      } else {
        setSubmitError("Network hiccup. Try again?");
      }
    } else {
      // Success! For first-time users (no existing profiles), show BW step
      if (existing.length === 0 && !isLocalProfile) {
        setClaimedName(trimmed);
        setShowBwStep(true);
      }
    }
  };

  // Visual state for availability pip
  const availabilityPip = () => {
    if (availability === "checking")     return { colour: T.text3, icon: "…",  label: "checking" };
    if (availability === "available")    return { colour: T.sage,  icon: "✓",  label: existing.some(e=>e.toLowerCase()===name.trim().toLowerCase()) ? "on this device" : "available" };
    if (availability === "taken")        return { colour: T.rose,  icon: "✕",  label: "taken" };
    if (availability === "network-err")  return { colour: T.gold,  icon: "?",  label: "offline — try anyway" };
    return null;
  };
  const pip = availabilityPip();

  // Post-claim BW step for first-time users
  if (showBwStep) {
    const handleBwSave = () => {
      if (claimedName && updateBodyweight) {
        updateBodyweight(pendingBw);
      }
      setShowBwStep(false);
    };
    const handleBwSkip = () => {
      setShowBwStep(false);
    };

    return (
      <div style={{
        background: T.bg0, minHeight: "100vh", maxWidth: 430, margin: "0 auto",
        fontFamily: T.sans, color: T.text1, WebkitFontSmoothing: "antialiased",
        padding: "72px 24px 48px", position: "relative", overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>

        <Fade d={0}>
          <div style={{
            fontSize: 11, fontWeight: 500, color: T.coral,
            letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 20,
          }}>
            One more thing
          </div>
          <div style={{ fontFamily: T.serif, fontSize: 36, fontWeight: 300, lineHeight: 1.15, marginBottom: 16 }}>
            What do you weigh?
          </div>
        </Fade>

        <Fade d={80}>
          <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.6, marginBottom: 32 }}>
            Optional — but it lets us track bodyweight movements (pull-ups, dips, planks) properly.
          </p>
        </Fade>

        <Fade d={140}>
          <div style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
            <ScrollDrum
              value={pendingBw}
              onChange={setPendingBw}
              min={40}
              max={200}
              step={0.5}
              label="kg"
            />
          </div>
        </Fade>

        <Fade d={200}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={handleBwSave} style={{
              width: "100%", padding: "18px 24px",
              background: T.coral, border: "none", borderRadius: T.r.lg, cursor: "pointer",
              fontFamily: T.serif, fontSize: 20, fontWeight: 400, color: T.bg0,
              boxShadow: `0 12px 40px ${s.glow}`,
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}>
              <span>Save & continue</span>
              <span style={{ fontSize: 18 }}>→</span>
            </button>
            <button onClick={handleBwSkip} style={{
              width: "100%", padding: "14px 24px",
              background: "transparent", border: "none", cursor: "pointer",
              fontFamily: T.sans, fontSize: 14, fontWeight: 400, color: T.text3,
            }}>
              Skip
            </button>
          </div>
        </Fade>
      </div>
    );
  }

  return (
    <div style={{background:T.bg0,minHeight:"100vh",maxWidth:430,margin:"0 auto",fontFamily:T.sans,color:T.text1,WebkitFontSmoothing:"antialiased",padding:"72px 24px 48px",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-160,left:"50%",transform:"translateX(-50%)",width:500,height:440,background:`radial-gradient(ellipse,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      {onCancel&&<button onClick={onCancel} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans,marginBottom:32,display:"block"}}>← Back</button>}
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:36,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          {current?"Switch profile":"Who's training?"}
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:36,lineHeight:1.6}}>
          {current?"Pick a profile or add someone new.":"Pick a name. It travels with you across devices."}
        </p>
      </Fade>
      {existing.length>0&&(
        <Fade d={60}>
          <div style={{marginBottom:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>On this device</div>
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {existing.map(n=>(
                <div key={n} style={{padding:"16px 20px",borderRadius:T.r.lg,background:n===current?`${T.coral}12`:T.bg2,border:`1px solid ${n===current?T.coral+"44":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
                  <span onClick={()=>onActivate(n)} style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,cursor:"pointer",flex:1}}>{n}</span>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    {n===current&&<span style={{fontSize:11,color:T.coral,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>Active</span>}
                    <button onClick={()=>setConfirmWipe(n)} style={{background:"none",border:"none",padding:"2px 6px",cursor:"pointer",fontSize:11,color:T.text4,fontFamily:T.sans}} title="Wipe progress">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Fade>
      )}
      <Fade d={120}>
        <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
          {existing.length > 0 ? "Add new" : "Pick your name"}
        </div>
        <div style={{position:"relative"}}>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1,position:"relative"}}>
              <input value={name} onChange={e=>{setName(e.target.value); setSubmitError(null);}}
                onKeyDown={e=>{if(e.key==="Enter"&&canSubmit) handleSubmit();}}
                placeholder="Your name"
                autoComplete="off" autoCorrect="off" autoCapitalize="words" spellCheck="false"
                style={{width:"100%",background:T.bg2,border:`1px solid ${availability==="taken"?T.rose+"55":availability==="available"?T.sage+"55":T.bg3}`,borderRadius:T.r.md,padding:"14px 48px 14px 16px",fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,outline:"none",caretColor:T.coral,transition:`border 180ms ${T.ease}`}}
              />
              {pip && (
                <div style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",display:"flex",alignItems:"center",gap:6,pointerEvents:"none"}}>
                  <span style={{fontSize:14,color:pip.colour,fontWeight:500}}>{pip.icon}</span>
                </div>
              )}
            </div>
            <button onClick={handleSubmit} disabled={!canSubmit}
              style={{padding:"14px 20px",background:canSubmit?T.coral:T.bg3,border:"none",borderRadius:T.r.md,cursor:canSubmit?"pointer":"default",fontFamily:T.serif,fontSize:18,fontWeight:400,color:canSubmit?T.bg0:T.text4,transition:`all 200ms ${T.ease}`}}>
              {submitting ? "…" : "→"}
            </button>
          </div>
          {/* Subscript — availability status or helper text */}
          <div style={{marginTop:10,minHeight:16,fontSize:11,fontFamily:T.sans,color:pip?.colour || T.text3,display:"flex",alignItems:"center",gap:6,transition:`color 180ms ${T.ease}`}}>
            {submitError ? (
              <span style={{color:T.rose}}>{submitError}</span>
            ) : pip ? (
              <span>{pip.label === "available" && "Available · this will be your username"}
                    {pip.label === "on this device" && "Welcome back"}
                    {pip.label === "taken" && "Already taken on Forge"}
                    {pip.label === "checking" && "Checking…"}
                    {pip.label === "offline — try anyway" && "Couldn't check online — you can still proceed"}
              </span>
            ) : (
              <span style={{color:T.text4}}>2+ characters. Case doesn't matter.</span>
            )}
          </div>

          {/* Taken → escape hatch. Cross-device sign-in lives here once
              pairing ships. For now, surfaces an honest explainer. */}
          {availability === "taken" && (
            <button
              type="button"
              onClick={() => setShowTakenHelp(true)}
              style={{
                marginTop:12,background:"none",border:"none",padding:0,
                cursor:"pointer",fontFamily:T.sans,fontSize:12,
                color:T.coral,textAlign:"left",letterSpacing:"0.02em",
              }}>
              That's me →
            </button>
          )}
        </div>
      </Fade>

      {/* Tone-of-voice card — sets expectations on data + PII */}
      <Fade d={180}>
        <div style={{marginTop:36,padding:"18px 20px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
            No email. No phone.
          </div>
          <div style={{fontFamily:T.serif,fontSize:19,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
            We don&apos;t want your <span style={{fontStyle:"italic",color:T.coral}}>starsign</span> either.
          </div>
          <p style={{fontSize:13,color:T.text3,lineHeight:1.6}}>
            Forge keeps your data yours. A name is all we need — it syncs your streak and weights across your devices. Nothing more.
          </p>
        </div>
      </Fade>

      {/* Sync status card — shows cloud connection state */}
      {current && (
        <Fade d={240}>
          <SyncStatusCard profile={current} />
        </Fade>
      )}

      {/* Bodyweight row — tappable to edit */}
      {current && setBwEditOpen && (
        <Fade d={260}>
          <div onClick={()=>setBwEditOpen(true)}
            style={{marginTop:16,padding:"14px 18px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Bodyweight</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>
                {bodyweight ? (
                  (() => {
                    const bwData = BW.get(current);
                    const daysAgo = bwData?.ageMs ? Math.floor(bwData.ageMs / 86400000) : null;
                    const agoStr = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : daysAgo !== null ? `${daysAgo} days ago` : "";
                    return `${bodyweight} kg${agoStr ? ` · updated ${agoStr}` : ""}`;
                  })()
                ) : "Not set — add one ↗"}
              </div>
            </div>
            <span style={{fontSize:14,color:T.text3}}>↗</span>
          </div>
        </Fade>
      )}

      {/* Passkey setup card — only show if WebAuthn is supported and profile doesn't have one */}
      {current && webAuthnSupported && !profileHasPasskey[current] && (
        <Fade d={280}>
          <div style={{marginTop:16,padding:"18px 20px",background:T.bg2,border:`1px solid ${T.sage}33`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:16}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8}}>
                  Secure your profile
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:6}}>
                  Add a passkey
                </div>
                <p style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Use Face ID, Touch ID, or your device PIN to protect your data and sign in on other devices.
                </p>
              </div>
              <button
                onClick={handleRegisterPasskey}
                disabled={passkeyBusy}
                style={{
                  padding:"10px 16px",
                  background:T.sage,
                  border:"none",
                  borderRadius:T.r.md,
                  fontSize:13,
                  fontWeight:500,
                  color:T.bg0,
                  cursor:passkeyBusy?"default":"pointer",
                  opacity:passkeyBusy?0.6:1,
                  whiteSpace:"nowrap",
                }}
              >
                {passkeyBusy ? "..." : "Set up"}
              </button>
            </div>
            {passkeyError && (
              <div style={{marginTop:12,padding:"8px 12px",borderRadius:T.r.sm,background:`${T.rose}14`,fontSize:11,color:T.rose}}>
                {passkeyError}
              </div>
            )}
          </div>
        </Fade>
      )}

      {/* Passkey enabled badge */}
      {current && profileHasPasskey[current] && (
        <Fade d={280}>
          <div style={{marginTop:16,padding:"14px 18px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:T.sage}}/>
            <div>
              <div style={{fontSize:13,fontWeight:500,color:T.text1}}>Passkey enabled</div>
              <div style={{fontSize:11,color:T.text3,marginTop:2}}>Your profile is secured with biometric auth</div>
            </div>
          </div>
        </Fade>
      )}

      {/* Passkey auth required modal */}
      {needsPasskeyAuth && (
        <div onClick={()=>setNeedsPasskeyAuth(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:T.r.xl,padding:"32px 28px",width:"90%",maxWidth:340,textAlign:"center"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
              Authentication required
            </div>
            <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.25,marginBottom:12}}>
              Verify it&apos;s you
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.55}}>
              This profile has a passkey. Use Face ID, Touch ID, or your device PIN to continue.
            </p>
            {passkeyError && (
              <div style={{marginBottom:16,padding:"10px 14px",borderRadius:T.r.md,background:`${T.rose}14`,fontSize:12,color:T.rose}}>
                {passkeyError}
              </div>
            )}
            <button
              onClick={handlePasskeyAuth}
              disabled={passkeyBusy}
              style={{
                width:"100%",
                padding:"16px",
                background:T.coral,
                border:"none",
                borderRadius:T.r.lg,
                fontSize:16,
                fontWeight:500,
                color:T.bg0,
                cursor:passkeyBusy?"default":"pointer",
                opacity:passkeyBusy?0.6:1,
                marginBottom:12,
              }}
            >
              {passkeyBusy ? "Verifying..." : "Authenticate"}
            </button>
            <button
              onClick={()=>{setNeedsPasskeyAuth(null);setPasskeyError(null);}}
              style={{background:"none",border:"none",padding:"8px",fontSize:13,color:T.text3,cursor:"pointer"}}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirmWipe&&(
        <div onClick={()=>!wipeBusy&&setConfirmWipe(null)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.rose}33`,animation:`slideUp 240ms ${T.ease}`,maxHeight:"92vh",overflowY:"auto",boxSizing:"border-box"}}>
            <div style={{fontFamily:T.serif,fontSize:24,fontWeight:300,lineHeight:1.2,marginBottom:8}}>
              Wipe <span style={{color:T.rose,fontStyle:"italic"}}>{confirmWipe}</span>?
            </div>
            <p style={{fontSize:13,color:T.text2,marginBottom:24,lineHeight:1.6}}>
              Choose how far this goes. Local keeps your data in the cloud — you can reclaim the name by typing it again. Full wipe releases the name and deletes everything.
            </p>

            {wipeError && (
              <div style={{padding:"10px 14px",marginBottom:16,borderRadius:T.r.md,background:`${T.rose}14`,border:`1px solid ${T.rose}44`,fontSize:12,color:T.rose,lineHeight:1.5}}>
                {wipeError}
              </div>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:12}}>
              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:false})}
                style={{padding:"16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.text1,lineHeight:1.3,marginBottom:3}}>
                  Remove from this device
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Cloud data stays. Reclaim the name any time.
                </div>
              </button>

              <button
                disabled={wipeBusy}
                onClick={()=>wipeProfile(confirmWipe,{cloud:true})}
                style={{padding:"16px",background:`${T.rose}18`,border:`1px solid ${T.rose}55`,borderRadius:T.r.lg,cursor:wipeBusy?"default":"pointer",textAlign:"left",opacity:wipeBusy?0.5:1}}>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.rose,lineHeight:1.3,marginBottom:3}}>
                  {wipeBusy ? "Wiping…" : "Full wipe — cloud & device"}
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Deletes all weights, history, and the name claim. Can't be undone.
                </div>
              </button>
            </div>

            <button
              disabled={wipeBusy}
              onClick={()=>setConfirmWipe(null)}
              style={{width:"100%",padding:"12px",background:"none",border:"none",cursor:wipeBusy?"default":"pointer",fontFamily:T.sans,fontSize:13,color:T.text3}}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Taken name → passkey sign-in or fallback explainer */}
      {showTakenHelp && (
        <TakenNameModal
          name={name.trim()}
          webAuthnSupported={webAuthnSupported}
          onClose={() => setShowTakenHelp(false)}
          onActivate={onActivate}
          passkeyBusy={passkeyBusy}
          setPasskeyBusy={setPasskeyBusy}
          passkeyError={passkeyError}
          setPasskeyError={setPasskeyError}
        />
      )}

      {/* Bodyweight edit modal — rendered here so it works within ProfileScreen's early return */}
      <BodyweightEditModal open={bwEditOpen} onClose={()=>setBwEditOpen(false)} currentKg={bodyweight} onSave={updateBodyweight}/>
    </div>
  );
}

// ─── Home ──────────────────────────────────��──────────────────────────────────
function HomeScreen({rhythm,profileName,onBegin,onProfile,weekDone={},onMarkDayDone,programmeBlock,weeksOnBlock,onRotate,onPerformance,historyCount=0,recoveryNudge=null,onDismissRecovery,syncState="idle",pendingDraft=null,onResumeDraft,onDiscardDraft,showBwCard=false,onOpenBwEdit,onDismissBwCard}){
  const dow      = new Date().getDay(); // 0=Sun
  const weekMap  = [6,0,1,2,3,4,5];    // JS day → WEEK index (Mon=0 … Sun=6)
  const todayIdx = weekMap[dow];

  const [viewIdx, setViewIdx] = useState(todayIdx);

  const viewDay        = WEEK[viewIdx];
  const cfg            = DAY_CONFIG[viewDay.type] || DAY_CONFIG.rest;
  const accent         = T[viewDay.type] || T.rest;
  const isViewingToday = viewIdx === todayIdx;

  // Resolve which session to preview for the viewed day (null for non-strength days)
  const viewSessionIdx = STRENGTH_DAY_SESSIONS[viewIdx];
  const viewSession    = viewSessionIdx !== undefined ? SESSIONS[viewSessionIdx] : null;

  // Dynamic headline/sub for strength days
  const headline2 = viewSession ? viewSession.subtitle : cfg.headline[1];
  const subText   = viewSession ? viewSession.subtitle : cfg.sub;

  // Negative diff = earlier this week, positive = later this week
  const diffDays = viewIdx - todayIdx;

  const dayLabel = diffDays === 0
    ? "Today"
    : diffDays === 1
    ? "Tomorrow"
    : diffDays === -1
    ? "Yesterday"
    : DAY_NAMES[viewIdx];

  // Actual date of the viewed day
  const viewDate = new Date(Date.now() + diffDays * 86400000);

  return (
    <div style={{minHeight:"100vh",paddingBottom:48,position:"relative",overflow:"hidden"}}>
      {/* Ambient glow — colour transitions with the viewed day */}
      <div style={{
        position:"absolute",top:-180,left:"50%",transform:"translateX(-50%)",
        width:600,height:500,
        background:`radial-gradient(ellipse,${accent.glow} 0%,transparent 65%)`,
        pointerEvents:"none",
        transition:`background 400ms ${T.ease}`,
      }}/>

      {/* Header */}
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
            <StreakBadge rhythm={rhythm}/>
            <button onClick={onProfile} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:11,color:T.text3,fontFamily:T.sans,fontWeight:500,display:"flex",alignItems:"center",gap:6}}>
              {profileName}
              {syncState === "pulling" || syncState === "pushing" ? (
                <span style={{
                  width:6,height:6,borderRadius:"50%",
                  background:T.sage,
                  animation:"pulse 1s ease-in-out infinite",
                }}/>
              ) : syncState === "error" ? (
                <span style={{width:6,height:6,borderRadius:"50%",background:T.coral,opacity:0.6}}/>
              ) : null}
              <span style={{marginLeft:2}}>↗</span>
            </button>
          </div>
        </div>
      </Fade>

      {/* Week strip — tappable */}
      <Fade d={60}>
        <div style={{padding:"28px 24px 0",display:"flex",gap:8}}>
          {WEEK.map((d,i)=>{
            const a       = T[d.type];
            const isToday = i === todayIdx;
            const isView  = i === viewIdx;
            const isDone  = weekDone[i];
            return (
              <div key={i} onClick={()=>setViewIdx(i)}
                style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6,cursor:"pointer"}}>
                <div style={{
                  width:34,height:34,borderRadius:"50%",
                  background: isToday ? a.main : isDone ? `${a.main}28` : isView ? `${a.main}20` : T.bg2,
                  border:`${isView && !isToday ? "2px" : "1px"} solid ${isToday || isView || isDone ? a.main : T.bg3}`,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  boxShadow: isToday ? `0 0 20px ${a.glow}` : isView ? `0 0 10px ${a.glow}` : "none",
                  transition:`all 200ms ${T.ease}`,
                }}>
                  {isDone && !isToday
                    ? <span style={{fontSize:14,color:a.main,lineHeight:1}}>✓</span>
                    : <span style={{fontSize:12,fontWeight:500,color:isToday?T.bg0:isView?a.main:T.text3,transition:`color 200ms ${T.ease}`}}>{d.s}</span>
                  }
                </div>
                <span style={{
                  fontSize:8,fontWeight:500,
                  color: isToday ? a.main : isDone ? a.main : isView ? a.main : T.text4,
                  letterSpacing:"0.06em",textTransform:"uppercase",
                  transition:`color 200ms ${T.ease}`,
                }}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </Fade>

      {/* Day headline — driven by viewIdx */}
      <Fade d={100}>
        <div style={{padding:"28px 24px 0"}}>
          {/* "Today" / "Tomorrow" / day-name label row */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <div style={{
              fontSize:11,fontWeight:500,letterSpacing:"0.12em",textTransform:"uppercase",
              color: isViewingToday ? T.text3 : accent.main,
              transition:`color 300ms ${T.ease}`,
            }}>
              {dayLabel}
            </div>
            {!isViewingToday && (
              <span style={{fontSize:10,color:T.text4,fontFamily:T.serif,fontStyle:"italic"}}>
                {viewDate.toLocaleDateString("en-GB",{day:"numeric",month:"short"})}
              </span>
            )}
          </div>
          <div style={{fontFamily:T.serif,fontSize:42,fontWeight:300,lineHeight:1.1}}>
            {cfg.headline[0]}<br/>
            {headline2 && (
              <span style={{color:accent.main,fontStyle:"italic",transition:`color 300ms ${T.ease}`}}>
                {headline2}
              </span>
            )}
          </div>
          <div style={{fontSize:14,color:T.text2,marginTop:10,lineHeight:1.5}}>
            {viewSession ? viewSession.subtitle : cfg.sub}
          </div>
        </div>
      </Fade>

      {/* Strength day — session card + CTA */}
      {cfg.canBegin && viewSession && (
        <>
          <Fade d={160}>
            <Card style={{margin:"24px 24px 0",padding:0,overflow:"hidden"}}>
              <div style={{height:2,background:`linear-gradient(90deg,${accent.main},${accent.main}00)`,transition:`background 400ms ${T.ease}`}}/>
              <div style={{padding:"20px 22px 24px"}}>
                <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>Session overview</div>
                {/* Stats row — derived from session */}
                {(()=>{
                  const supersets = viewSession.blocks.filter(b=>b.type==="superset").length;
                  return (
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",paddingBottom:18,marginBottom:18,borderBottom:`1px solid ${T.bg3}`}}>
                      {[[String(viewSession.blocks.length),"Blocks"],["~65 min","Duration"],[String(supersets),"Supersets"]].map(([v,l])=>(
                        <div key={l}>
                          <div style={{fontFamily:T.serif,fontSize:24,fontWeight:400,lineHeight:1}}>{v}</div>
                          <div style={{fontSize:11,color:T.text3,marginTop:4}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                {/* Exercise list — derived from session blocks */}
                {viewSession.blocks.map((b,i,arr)=>{
                  const tag   = b.type==="main" ? "Main" : b.type==="superset" ? "Superset" : "Finisher";
                  const color = tag==="Main" ? T.coral : tag==="Superset" ? T.sage : T.gold;
                  const name  = b.type==="main"
                    ? b.ex.name
                    : `${(b.exA||b.ex).name} ↔ ${(b.exB||b.ex).name}`;
                  const sets  = b.type==="main"
                    ? `${b.sets}×${b.ex.reps}`
                    : `${b.sets}×${b.exA?.reps||b.exB?.reps}`;
                  return (
                    <div key={b.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:i<arr.length-1?`1px solid ${T.bg3}`:"none"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,flex:1,minWidth:0}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:color,flexShrink:0}}/>
                        <span style={{fontSize:13,color:T.text1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{name}</span>
                      </div>
                      <span style={{fontFamily:T.serif,fontSize:13,color:T.text3,fontStyle:"italic",flexShrink:0,marginLeft:12}}>{sets}</span>
                    </div>
                  );
                })}
              </div>
            </Card>
          </Fade>
          <Fade d={220}>
            {isViewingToday && weekDone[todayIdx] ? (
              <div style={{margin:"16px 24px 0",padding:"16px 20px",background:`${accent.main}10`,border:`1px solid ${accent.main}40`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:18,color:accent.main}}>✓</span>
                <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Session complete. See you next time.</span>
              </div>
            ) : isViewingToday ? (
              <button onClick={onBegin} style={{
                margin:"16px 24px 0",width:"calc(100% - 48px)",
                padding:"18px 24px",background:accent.main,border:"none",
                borderRadius:T.r.lg,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"space-between",
                boxShadow:`0 12px 40px ${accent.glow}`,
              }}>
                <span style={{fontFamily:T.serif,fontSize:20,fontWeight:400,color:T.bg0}}>Begin session</span>
                <span style={{fontSize:18,color:T.bg0}}>→</span>
              </button>
            ) : (
              <div style={{
                margin:"16px 24px 0",padding:"16px 20px",
                background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,
                display:"flex",alignItems:"center",justifyContent:"space-between",
                gap:12,
              }}>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:300,color:T.text3,fontStyle:"italic"}}>
                  {diffDays > 0 ? "Upcoming" : "Past session"}
                </span>
                <Tag color={accent.main}>{viewDate.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</Tag>
              </div>
            )}
          </Fade>
        </>
      )}

      {/* Non-strength day — tips card + mark complete */}
      {!cfg.canBegin && cfg.tips && (
        <Fade d={160}>
          <Card style={{margin:"24px 24px 0",padding:"20px 22px 24px"}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:16}}>
              {viewDay.type==="rest" ? "Recovery notes" : "Session notes"}
            </div>
            {cfg.tips.map((tip,i)=>(
              <div key={i} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"8px 0",borderBottom:i<cfg.tips.length-1?`1px solid ${T.bg3}`:"none"}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:accent.main,flexShrink:0,marginTop:5,transition:`background 300ms ${T.ease}`}}/>
                <span style={{fontSize:13,color:T.text2,lineHeight:1.5}}>{tip}</span>
              </div>
            ))}
          </Card>
        </Fade>
      )}
      {!cfg.canBegin && isViewingToday && (
        <Fade d={220}>
          {weekDone[todayIdx] ? (
            <div style={{margin:"12px 24px 0",padding:"16px 20px",background:`${accent.main}10`,border:`1px solid ${accent.main}40`,borderRadius:T.r.lg,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:18,color:accent.main}}>✓</span>
              <span style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:accent.main,fontStyle:"italic"}}>Done. Streak maintained.</span>
            </div>
          ) : (
            <button onClick={onMarkDayDone} style={{
              margin:"12px 24px 0",width:"calc(100% - 48px)",
              padding:"16px 20px",background:"transparent",
              border:`1px solid ${accent.main}`,borderRadius:T.r.lg,cursor:"pointer",
              display:"flex",alignItems:"center",justifyContent:"space-between",
            }}>
              <span style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:accent.main}}>Mark complete</span>
              <span style={{fontSize:16,color:accent.main}}>✓</span>
            </button>
          )}
        </Fade>
      )}

      {/* Pick up where you left off — an interrupted session from within the
          last 12 hours. Coral-tinted; the session is top-priority if it exists. */}
      {pendingDraft && (
        <Fade d={160}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.coral}0E`,border:`1px solid ${T.coral}40`,borderRadius:T.r.lg,boxShadow:`0 8px 28px ${T.coral}10`}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:14}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  Unfinished session
                </div>
                <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text1,lineHeight:1.25}}>
                  Pick up where you<br/><span style={{fontStyle:"italic",color:T.coral}}>left off.</span>
                </div>
                <div style={{fontSize:12,color:T.text3,marginTop:8,lineHeight:1.5}}>
                  {pendingDraft.setCount} {pendingDraft.setCount === 1 ? "set" : "sets"} logged · {formatAgo(pendingDraft.ageMs)}
                </div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={onResumeDraft}
                style={{flex:1,padding:"12px 16px",background:T.coral,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:400,color:T.bg0}}>
                Resume →
              </button>
              <button onClick={onDiscardDraft}
                style={{padding:"12px 16px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,cursor:"pointer",fontFamily:T.sans,fontSize:13,fontWeight:500,color:T.text3}}>
                Discard
              </button>
            </div>
          </div>
        </Fade>
      )}

      {/* BW re-prompt card — surfaces when bodyweight is stale (>14 days or never set) */}
      {showBwCard && (
        <Fade d={180}>
          <div onClick={onOpenBwEdit}
            style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.sage}0E`,border:`1px solid ${T.sage}40`,borderRadius:T.r.lg,cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  Bodyweight
                </div>
                <div style={{fontFamily:T.serif,fontSize:18,fontWeight:300,color:T.text1,lineHeight:1.35,marginBottom:4}}>
                  How much do you weigh today?
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Tap to update — keeps loaded pull-ups and dips honest.
                </div>
              </div>
              <button onClick={(e)=>{e.stopPropagation();onDismissBwCard();}} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
          </div>
        </Fade>
      )}

      {/* Honest recovery nudge — surfaces when the last 2 sessions were cooked.
          Non-pushy. Dismisses in-memory for this session. */}
      {recoveryNudge && (
        <Fade d={180}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.sage}0E`,border:`1px solid ${T.sage}35`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.sage,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:6}}>
                  A gentle nudge
                </div>
                <div style={{fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text1,lineHeight:1.45,fontStyle:"italic"}}>
                  {recoveryNudge.message}
                </div>
              </div>
              <button onClick={onDismissRecovery} aria-label="Dismiss"
                style={{flexShrink:0,background:"none",border:"none",padding:"4px 8px",cursor:"pointer",fontSize:14,color:T.text3,fontFamily:T.sans}}>✕</button>
            </div>
          </div>
        </Fade>
      )}

      {/* Rotation nudge — surfaces after 4 weeks on a block */}
      {weeksOnBlock >= 4 && (
        <Fade d={200}>
          <div style={{margin:"20px 24px 0",padding:"18px 20px",background:`${T.gold}10`,border:`1px solid ${T.gold}40`,borderRadius:T.r.lg}}>
            <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
              <div style={{flex:1}}>
                <div style={{fontSize:11,fontWeight:500,color:T.gold,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>
                  Block {programmeBlock?.number} · {weeksOnBlock} weeks
                </div>
                <div style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,lineHeight:1.3,marginBottom:4}}>
                  Time to rotate accessories
                </div>
                <div style={{fontSize:12,color:T.text3,lineHeight:1.5}}>
                  Your body has adapted. New exercises, same muscle targets.
                </div>
              </div>
              <button onClick={onRotate} style={{flexShrink:0,marginTop:2,padding:"10px 16px",background:T.gold,border:"none",borderRadius:T.r.md,cursor:"pointer",fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.bg0}}>
                Rotate →
              </button>
            </div>
          </div>
        </Fade>
      )}

      {/* Performance Lab entry — always visible, becomes active once data exists */}
      <Fade d={260}>
        <div onClick={onPerformance}
          style={{margin:"20px 24px 0",padding:"18px 20px",background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,transition:`all 200ms ${T.ease}`}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>
              Performance lab
            </div>
            <div style={{fontFamily:T.serif,fontSize:19,fontWeight:300,color:T.text1,lineHeight:1.3,marginBottom:3}}>
              {historyCount === 0
                ? "Your progress, visualised"
                : `${historyCount} session${historyCount===1?"":"s"} logged`}
            </div>
            <div style={{fontSize:12,color:T.text3,lineHeight:1.5,fontFamily:T.serif,fontStyle:"italic"}}>
              {historyCount === 0
                ? "Complete a session to light it up"
                : "1RM trends · weekly volume · consistency"}
            </div>
          </div>
          <div style={{flexShrink:0,width:40,height:40,borderRadius:"50%",background:historyCount > 0 ? `${T.gold}18` : T.bg3,border:`1px solid ${historyCount > 0 ? T.gold+"55" : T.bg4}`,display:"flex",alignItems:"center",justifyContent:"center",transition:`all 200ms ${T.ease}`}}>
            <span style={{fontSize:16,color:historyCount > 0 ? T.gold : T.text3}}>→</span>
          </div>
        </div>
      </Fade>
    </div>
  );
}

// ─── Readiness ─────────────────────────────────────────────────────────────────
function ReadinessScreen({readiness,setReadiness,reason,setReason,onStart}){
  const opts=[
    {id:"fresh", icon:"○",label:"Fresh", sub:"Full programme. Push today.",       color:T.sage},
    {id:"normal",icon:"◐",label:"Normal",sub:"Standard session.",                  color:T.gold},
    {id:"cooked",icon:"●",label:"Cooked",sub:"Deload weights · trimmed volume.",   color:T.rose},
  ];
  // Short, enum-only reasons. Fed into session record so patterns can surface.
  // Only surfaces when readiness is "cooked" — the one state where context
  // is actually load-bearing for future pattern detection. Keeps the rest of
  // the flow friction-free.
  const reasons = [
    {id:"slept_badly", label:"Slept badly"},
    {id:"stressed",    label:"Stressed"},
    {id:"recovering",  label:"Still recovering"},
    {id:"sore",        label:"Sore"},
    {id:"other",       label:"Something else"},
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
            <div onClick={()=>{ setReadiness(o.id); if (o.id !== "cooked") setReason(null); }} style={{padding:"18px 20px",borderRadius:T.r.lg,cursor:"pointer",background:readiness===o.id?`${o.color}12`:T.bg2,border:`1px solid ${readiness===o.id?o.color+"55":T.bg3}`,display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 200ms ${T.ease}`}}>
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

      {/* Optional "why?" — only surfaces when user picked Cooked.
          Fresh/Normal sessions skip this to keep the flow friction-free.
          Still skippable even when shown. */}
      {readiness === "cooked" && (
        <Fade d={0}>
          <div style={{marginTop:28}}>
            <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10,display:"flex",alignItems:"baseline",justifyContent:"space-between"}}>
              <span>What's going on?</span>
              <span style={{fontSize:10,fontFamily:T.serif,fontStyle:"italic",color:T.text4,textTransform:"none",letterSpacing:0}}>optional</span>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {reasons.map(r => {
                const sel = reason === r.id;
                return (
                  <div key={r.id} onClick={()=>setReason(sel ? null : r.id)}
                    style={{padding:"8px 14px",borderRadius:T.r.pill,cursor:"pointer",background:sel?`${T.rose}18`:T.bg2,border:`1px solid ${sel?T.rose+"55":T.bg3}`,fontSize:13,fontFamily:T.serif,fontWeight:300,color:sel?T.text1:T.text2,transition:`all 180ms ${T.ease}`}}>
                    {r.label}
                  </div>
                );
              })}
            </div>
          </div>
        </Fade>
      )}

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

// ─── Session ──────────────────────────────────────────────────────────────────
function SessionScreen({session,block,blockIdx,totalBlocks,setNum,phase,isSS,activeEx,resolvedExA,resolvedExB,resolvedEx,swapKey,onSwap,showVid,setShowVid,getW,getR,editTarget,setEditTarget,workingWeights,setWW,workingReps,setWR,awaitRpe,ssRoundDone,restActive,restRemain,setRestActive,setRestRemain,onCommit,onLog,onQuit,bodyweight}){
  const {strength:s}=T;
  const [swapEx,setSwapEx]=useState(null);
  const partnerEx=isSS?(phase==="A"?resolvedExB:resolvedExA):null;
  const vidEx    =isSS?(phase==="A"?resolvedExA:resolvedExB):resolvedEx;
  const progress =((blockIdx+(setNum-1)/block.sets)/totalBlocks)*100;
  const nameFz   =Math.min(38,Math.max(24,300/(activeEx?.name?.length||10)));
  const typeLabel={main:"Main lift",superset:"Superset",finisher:"Finisher"}[block.type];
  const currentW =getW(activeEx);
  const showRestHint=!isSS;
  const restMins =Math.floor(restRemain/60),restSecs=restRemain%60;
  const restStr  =`${restMins}:${String(restSecs).padStart(2,"0")}`;
  const blocking =awaitRpe||ssRoundDone;
  
  // Load type handling for bodyweight movements
  const loadType = activeEx?.loadType || inferLoadType(activeEx?.name);
  const showWeightPicker = loadType !== "bodyweight";
  const weightLabel = loadType === "loaded_bodyweight" ? "+ kg"
                    : loadType === "assisted_bodyweight" ? "− kg"
                    : "kg";
  const loadTypeSubtitle = loadType === "bodyweight" ? "Bodyweight"
                         : loadType === "loaded_bodyweight" ? "Added load"
                         : loadType === "assisted_bodyweight" ? "Band assist"
                         : null;

  return (
    <div style={{minHeight:"100vh",position:"relative",overflow:"hidden",paddingBottom:40}}>
      <div style={{position:"absolute",top:-80,right:-80,width:340,height:320,background:`radial-gradient(circle,${s.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <div style={{height:1,background:T.bg3}}>
        <div style={{height:"100%",width:`${progress}%`,background:T.coral,transition:`width 600ms ${T.ease}`}}/>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <button onClick={onQuit} style={{background:"none",border:"none",padding:0,cursor:"pointer",fontSize:12,color:T.text3,fontFamily:T.sans}}>← Quit</button>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.1em",textTransform:"uppercase"}}>{session.name}</div>
          <div style={{fontSize:10,color:T.text3,fontStyle:"italic",fontFamily:T.serif,marginTop:1}}>{block.label}</div>
        </div>
      </div>
      <div style={{padding:"14px 20px 0",display:"flex",gap:8,flexWrap:"wrap"}}>
        <Tag color={block.type==="main"?T.coral:block.type==="superset"?T.sage:T.gold}>{typeLabel}</Tag>
        {isSS&&<Tag color={T.steel}>Exercise {phase}</Tag>}
      </div>
      <div style={{padding:"14px 20px 0"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
          <div onClick={activeEx?.vid ? ()=>setShowVid(true) : undefined}
            style={{cursor:activeEx?.vid?"pointer":"default",flex:1,userSelect:"none"}}>
            <div style={{fontFamily:T.serif,fontSize:nameFz,fontWeight:300,lineHeight:1.1}}>{activeEx?.name}</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:8}}>
              {activeEx?.vid && (
                <span style={{fontSize:11,color:T.coral,fontWeight:500}}>▶ Watch demo</span>
              )}
              <span style={{fontSize:11,color:T.text3}}>{activeEx?.muscle}</span>
            </div>
          </div>
          <button
            onClick={()=>setSwapEx({block,phase})}
            style={{marginTop:4,flexShrink:0,background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.md,padding:"8px 12px",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,transition:`all 180ms ${T.ease}`}}
          >
            <span style={{fontSize:14}}>⇄</span>
            <span style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.08em",textTransform:"uppercase"}}>Swap</span>
          </button>
        </div>
      </div>
      <div style={{padding:"22px 20px 0"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase"}}>Set {setNum} of {block.sets}</div>
          {loadTypeSubtitle && (
            <span style={{fontSize:10,color:T.sage,fontWeight:500,letterSpacing:"0.08em",textTransform:"uppercase"}}>{loadTypeSubtitle}</span>
          )}
        </div>
        {showWeightPicker && currentW!==null&&(
          <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:4,cursor:"pointer",userSelect:"none"}} onClick={()=>setEditTarget({exName:activeEx.name,currentKg:currentW,currentReps:getR(activeEx),loadType})}>
            <span style={{fontFamily:T.serif,fontSize:80,fontWeight:300,color:T.text1,lineHeight:1,letterSpacing:"-0.02em"}}>{currentW}</span>
            <span style={{fontFamily:T.serif,fontSize:22,fontWeight:300,color:T.text3,marginBottom:8}}>{weightLabel}</span>
            <span style={{fontSize:11,color:T.text3,marginBottom:10,marginLeft:4}}>↕</span>
          </div>
        )}
        <div style={{display:"flex",alignItems:"baseline",gap:6,cursor:"pointer",userSelect:"none"}} onClick={()=>setEditTarget({exName:activeEx.name,currentKg:showWeightPicker?currentW:null,currentReps:getR(activeEx),loadType})}>
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
      {swapEx&&<SwapOverlay activeEx={activeEx} swapKey={swapKey} onSwap={onSwap} onClose={()=>setSwapEx(null)}/>}
      {showVid&&vidEx&&(
        <div onClick={()=>setShowVid(false)} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:200,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:24,width:"100%",maxWidth:430,borderTop:`1px solid ${T.coral}33`,animation:`slideUp 280ms ${T.ease}`}}>
            <style>{`@keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
              <div>
                <div style={{fontFamily:T.serif,fontSize:22,fontWeight:300,lineHeight:1.1}}>{vidEx.name}</div>
                <div style={{fontSize:12,color:T.text3,marginTop:4}}>{vidEx.muscle}</div>
              </div>
              <button onClick={()=>setShowVid(false)} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
            </div>
            <VideoEmbed vid={vidEx.vid} name={vidEx.name}/>
          </div>
        </div>
      )}
    </div>
  );
}


// ─── Video Embed ───────────────────────────────────────────────────────────────
// Handles embedding disabled / private videos gracefully.
// If the iframe fails to load (e.g. embedding disabled), shows a direct YouTube link.
function VideoEmbed({vid,name}){
  const [failed,setFailed]=useState(false);
  if(!vid||failed){
    return(
      <div style={{width:"100%",aspectRatio:"16/9",background:T.bg3,borderRadius:T.r.md,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:10}}>
        <span style={{fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif}}>
          {!vid?"No demo video linked yet":"Video unavailable here"}
        </span>
        {vid&&(
          <a href={`https://www.youtube.com/watch?v=${vid}`} target="_blank" rel="noopener noreferrer"
            style={{fontSize:12,color:T.coral,fontWeight:500,textDecoration:"none"}}>
            Watch on YouTube ↗
          </a>
        )}
      </div>
    );
  }
  return(
    <iframe
      key={vid}
      src={`https://www.youtube.com/embed/${vid}?autoplay=0&modestbranding=1&rel=0`}
      style={{width:"100%",aspectRatio:"16/9",border:"none",borderRadius:T.r.md,background:T.bg0,display:"block"}}
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
      onError={()=>setFailed(true)}
    />
  );
}

// ─── Swap Overlay ────────────────────────────────────────────────────────────

function SwapOverlay({activeEx,swapKey,onSwap,onClose}){
  const [travel,setTravel]=useState(false);
  const options=(SWAP_DB[activeEx?.name]||[]).filter(o=>!travel||["Bodyweight","Dumbbell","Band"].includes(o.eq));

  const applySwap=(option)=>{
    // Inherit reps/weight from current slot — same movement pattern, same stimulus level.
    // User can fine-tune with the drum editor after swapping.
    onSwap(swapKey, {
      name:   option.name,
      muscle: option.muscle,
      reps:   activeEx?.reps   ?? 10,
      weight: activeEx?.weight ?? null,
      vid:    option.vid ?? null,
    });
    onClose();
  };
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:300,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"24px 24px 36px",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
          <div>
            <div style={{fontSize:10,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>Swap exercise</div>
            <div style={{fontFamily:T.serif,fontSize:20,fontWeight:300,color:T.text2,fontStyle:"italic"}}>{activeEx?.name}</div>
          </div>
          <button onClick={onClose} style={{background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,padding:"6px 10px",cursor:"pointer",color:T.text2,fontSize:13}}>✕</button>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,margin:"14px 0",padding:"10px 14px",background:T.bg3,borderRadius:T.r.md,cursor:"pointer"}} onClick={()=>setTravel(p=>!p)}>
          <div style={{width:32,height:18,borderRadius:9,background:travel?T.coral:T.bg4,position:"relative",transition:`background 200ms ${T.ease}`,flexShrink:0}}>
            <div style={{position:"absolute",top:2,left:travel?14:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:`left 200ms ${T.ease}`}}/>
          </div>
          <div>
            <div style={{fontSize:13,color:T.text1,fontWeight:500}}>Travel mode</div>
            <div style={{fontSize:11,color:T.text3,marginTop:1}}>Bodyweight, dumbbell & band only</div>
          </div>
        </div>
        {options.length===0&&(
          <div style={{padding:"20px 0",fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>No alternatives for current filter</div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {options.map((o,i)=>(
            <div key={i} onClick={()=>applySwap(o)} style={{padding:"14px 16px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.md,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"space-between",transition:`all 180ms ${T.ease}`}}>
              <div>
                <span style={{fontFamily:T.serif,fontSize:17,fontWeight:300,color:T.text1,display:"block"}}>{o.name}</span>
                <span style={{fontSize:11,color:T.text3,marginTop:2,display:"block"}}>{o.muscle}</span>
              </div>
              <span style={{fontSize:10,fontWeight:500,color:EQ_COLOUR[o.eq]||T.text3,background:`${EQ_COLOUR[o.eq]||T.bg4}18`,border:`1px solid ${EQ_COLOUR[o.eq]||T.bg4}44`,borderRadius:T.r.pill,padding:"3px 10px",letterSpacing:"0.06em",textTransform:"uppercase",flexShrink:0,marginLeft:12}}>{o.eq}</span>
            </div>
          ))}
        </div>
        <div style={{marginTop:16,fontSize:11,color:T.text4,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>Tap an exercise to swap for this set</div>
      </div>
    </div>
  );
}

// ─── Rotation Summary Modal ───────────────────���───────────────────────────────
// Shown when auto-rotation fires. Non-dismissible — you acknowledge, you continue.
function RotationSummaryModal({summary,onContinue}){
  const {gold}=T;
  const count = summary.changes.length;
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.94)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px 32px",width:"100%",maxWidth:430,borderTop:`1px solid ${gold}44`,animation:`slideUp 280ms ${T.ease}`,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
        <div style={{fontSize:10,fontWeight:500,color:gold,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:8}}>
          New block · {summary.blockNumber}
        </div>
        <div style={{fontFamily:T.serif,fontSize:30,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
          Your programme<br/><span style={{color:gold,fontStyle:"italic"}}>has rotated.</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:20,lineHeight:1.6}}>
          {count} {count===1?"accessory":"accessories"} swapped to keep the stimulus fresh. Main lifts stay the same — progressive overload continues.
        </p>
        <div style={{flex:1,overflowY:"auto",marginBottom:20,marginRight:-8,paddingRight:8}}>
          {count===0 && (
            <div style={{padding:"20px 0",fontSize:13,color:T.text3,fontStyle:"italic",fontFamily:T.serif,textAlign:"center"}}>
              Rotation ran — same picks held. Rare but possible.
            </div>
          )}
          {summary.changes.map((c,i)=>(
            <div key={i} style={{padding:"12px 0",borderBottom:i<count-1?`1px solid ${T.bg3}`:"none"}}>
              <div style={{fontSize:10,fontWeight:500,color:T.text4,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:4}}>{c.slot}</div>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontFamily:T.serif,fontSize:14,fontWeight:300,color:T.text3,textDecoration:"line-through",textDecorationColor:T.text4}}>{c.from}</span>
                <span style={{fontSize:12,color:gold}}>→</span>
                <span style={{fontFamily:T.serif,fontSize:15,fontWeight:400,color:T.text1}}>{c.to}</span>
              </div>
            </div>
          ))}
        </div>
        <button onClick={onContinue} style={{width:"100%",padding:"16px 24px",background:gold,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:19,fontWeight:400,color:T.bg0,boxShadow:`0 12px 36px ${gold}33`}}>
          Continue to readiness →
        </button>
      </div>
    </div>
  );
}

// ─── Drum Edit ───────────────��─────────────────────────────────────────────────
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

// ─── Bodyweight Edit Modal ─────────────────────────────────────────────────────
// Reusable bottom-sheet modal for editing bodyweight. Triggered from:
// - Home screen BW re-prompt card
// - Profile settings BW row
// - Post-session BW prompt after logging bodyweight movements
function BodyweightEditModal({open,onClose,currentKg,onSave}){
  const [kg,setKg]=useState(currentKg || 75);
  
  // Update local state when modal opens with new value
  useEffect(()=>{
    if(open) setKg(currentKg || 75);
  },[open, currentKg]);
  
  if(!open) return null;
  
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,background:"rgba(10,9,8,0.92)",zIndex:400,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:T.bg2,borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,padding:"28px 24px calc(32px + env(safe-area-inset-bottom))",width:"100%",maxWidth:430,borderTop:`1px solid ${T.bg3}`,animation:`slideUp 260ms ${T.ease}`}}>
        <style>{`@keyframes slideUp{from{transform:translateY(60px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
        <div style={{marginBottom:24}}>
          <div style={{fontFamily:T.serif,fontSize:24,fontWeight:300,lineHeight:1.15,marginBottom:8}}>
            Your bodyweight
          </div>
          <div style={{fontSize:13,color:T.text3,lineHeight:1.5}}>
            Used to track loaded pull-ups, dips, and other bodyweight movements properly. We don't share this anywhere.
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"center",marginBottom:24}}>
          <ScrollDrum value={kg} onChange={setKg} step={0.5} min={40} max={200} label="kg"/>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <button onClick={()=>{onSave(kg);onClose();}} style={{width:"100%",padding:"16px",background:T.coral,border:"none",borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:18,fontWeight:400,color:T.bg0,boxShadow:`0 8px 28px ${T.strength.glow}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span>Save</span>
            <span style={{fontSize:16}}>→</span>
          </button>
          <button onClick={onClose} style={{width:"100%",padding:"12px",background:"none",border:"none",cursor:"pointer",fontFamily:T.sans,fontSize:14,color:T.text3}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Done ──────────────────────────────────────────────────────────────────────
const DONE_HEADLINES = [
  ["Solid", "work."],
  ["That's", "a session."],
  ["Job", "done."],
  ["Nothing", "wasted."],
];
const NEXT_DAY_MSG = {
  zone2:  "Zone 2 tomorrow. 60 min, conversational pace.",
  cardio: "Moderate cardio tomorrow. 35 min at ~75%.",
  hiit:   "HIIT tomorrow. 8–10 rounds, all out.",
  rest:   "Rest day tomorrow. You've earned it.",
  strength:"Strength session next. Load up.",
};

function DoneScreen({session,profileName,workingWeights,onHome}){
  const nudges = session.blocks.filter(b=>b.type==="main").map(b=>{
    const base    = b.ex.weight;
    const current = workingWeights[b.ex.name] ?? base;
    return { ex:b.ex.name, base, current, changed:current!==base };
  });

  // Pick a random headline pair, stable for this render
  const [hi] = useState(()=>DONE_HEADLINES[Math.floor(Math.random()*DONE_HEADLINES.length)]);

  // Derive what's next
  const dow     = new Date().getDay();
  const weekMap = [6,0,1,2,3,4,5];
  const todayIdx= weekMap[dow];
  const nextIdx = (todayIdx+1) % 7;
  const nextType= WEEK[nextIdx]?.type ?? "rest";
  const nextMsg = NEXT_DAY_MSG[nextType] ?? "";

  // Sync status for confirmation line
  const [syncState, setSyncState] = useState(SyncStatus.get());
  useEffect(() => SyncStatus.subscribe(setSyncState), []);

  return (
    <div style={{minHeight:"100vh",padding:"72px 24px 0",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:-120,left:"50%",transform:"translateX(-50%)",width:420,height:380,background:`radial-gradient(circle,${T.strength.glow} 0%,transparent 65%)`,pointerEvents:"none"}}/>
      <Fade d={0}>
        <div style={{fontFamily:T.serif,fontSize:13,fontWeight:300,fontStyle:"italic",color:T.text3,marginBottom:12}}>
          {profileName} · {session.name}
        </div>
        <div style={{fontFamily:T.serif,fontSize:48,fontWeight:300,lineHeight:1.05,marginBottom:8}}>
          {hi[0]}<br/><span style={{color:T.coral,fontStyle:"italic"}}>{hi[1]}</span>
        </div>
        <p style={{fontSize:14,color:T.text2,marginBottom:32,lineHeight:1.6}}>{nextMsg}</p>
      </Fade>
      {nudges.length > 0 && (
        <Fade d={80}>
          <div style={{fontSize:11,fontWeight:500,color:T.text3,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Main lifts</div>
        </Fade>
      )}
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

      {/* Sync confirmation line */}
      <Fade d={320}>
        <div style={{marginTop:24,textAlign:"center",fontSize:12,color:syncState.state==="idle"?T.sage:T.gold,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
          {syncState.state === "idle" || syncState.state === "pushing" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.sage}}/>
              Synced
            </>
          ) : syncState.state === "pulling" ? (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.steel,animation:"pulse 1s ease-in-out infinite"}}/>
              Syncing...
            </>
          ) : (
            <>
              <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.gold}}/>
              Saved locally — will sync when online
            </>
          )}
        </div>
      </Fade>
    </div>
  );
}

// ─── iOS Install Overlay ─────────────────────────────────────────────────────
// Safari on iOS doesn't surface beforeinstallprompt, so we walk the user
// through the native "Add to Home Screen" flow ourselves. Triggered after
// first completed session, dismissable, remembered via localStorage.
function IosInstallOverlay({ onDismiss }) {
  return (
    <div
      onClick={onDismiss}
      style={{
        position:"fixed",inset:0,background:"rgba(10,9,8,0.90)",zIndex:500,
        display:"flex",alignItems:"flex-end",justifyContent:"center",
        animation:`fadeIn 220ms ${T.ease}`,
      }}>
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <div onClick={e => e.stopPropagation()}
        style={{
          background:T.bg2,
          borderRadius:`${T.r.lg}px ${T.r.lg}px 0 0`,
          padding:"24px 24px calc(24px + env(safe-area-inset-bottom))",
          width:"100%",maxWidth:430,
          maxHeight:"92vh",overflowY:"auto",
          borderTop:`1px solid ${T.coral}33`,
          animation:`slideUp 280ms ${T.ease}`,
          position:"relative",
          boxSizing:"border-box",
        }}>
        <button onClick={onDismiss} aria-label="Dismiss"
          style={{position:"absolute",top:14,right:14,background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.sm,width:30,height:30,cursor:"pointer",color:T.text2,fontSize:13,padding:0,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>

        <div style={{fontSize:11,fontWeight:500,color:T.coral,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:8,paddingRight:40}}>
          Live on your home screen
        </div>
        <div style={{fontFamily:T.serif,fontSize:26,fontWeight:300,lineHeight:1.2,marginBottom:10}}>
          Install <span style={{fontStyle:"italic",color:T.coral}}>Forge</span>
        </div>
        <p style={{fontSize:13,color:T.text2,marginBottom:20,lineHeight:1.6}}>
          Fullscreen. One tap to open. Works offline between sessions.
        </p>

        {/* Three steps — Safari's share flow */}
        <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
          <InstallStep n="1">
            <span style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              Tap the share icon <ShareGlyph/>
            </span>
          </InstallStep>
          <InstallStep n="2">
            <span>Scroll and pick <span style={{color:T.text1,fontFamily:T.serif,fontStyle:"italic"}}>Add to Home Screen</span></span>
          </InstallStep>
          <InstallStep n="3">
            <span>Tap <span style={{color:T.text1,fontFamily:T.serif,fontStyle:"italic"}}>Add</span> — done</span>
          </InstallStep>
        </div>

        <button onClick={onDismiss}
          style={{width:"100%",padding:"14px",background:T.bg3,border:`1px solid ${T.bg4}`,borderRadius:T.r.lg,cursor:"pointer",fontFamily:T.serif,fontSize:16,fontWeight:300,color:T.text2}}>
          Maybe later
        </button>
      </div>
    </div>
  );
}

// SVG glyph approximating the iOS Safari share icon — a square with an
// up-arrow emerging from the top. Inline with the text, coral stroke.
function ShareGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="18" height="22" viewBox="0 0 18 22"
      style={{display:"inline-block",verticalAlign:"-5px",flexShrink:0}}
    >
      {/* Box — lower two thirds */}
      <rect x="2" y="8" width="14" height="12" rx="2" ry="2"
        fill="none" stroke={T.coral} strokeWidth="1.5"/>
      {/* Arrow shaft */}
      <line x1="9" y1="2" x2="9" y2="13"
        stroke={T.coral} strokeWidth="1.5" strokeLinecap="round"/>
      {/* Arrow head */}
      <polyline points="5,6 9,2 13,6"
        fill="none" stroke={T.coral} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function InstallStep({ n, children }) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:14}}>
      <div style={{
        flexShrink:0,width:28,height:28,borderRadius:"50%",
        background:`${T.coral}18`,border:`1px solid ${T.coral}44`,
        display:"flex",alignItems:"center",justifyContent:"center",
        fontFamily:T.serif,fontSize:14,fontWeight:400,color:T.coral,
      }}>{n}</div>
      <div style={{flex:1,fontSize:14,color:T.text2,lineHeight:1.5}}>
        {children}
      </div>
    </div>
  );
}

// ─── Shared ──────────────────────────────────────────────────────────��─────────
function Fade({children,d=0}){const s=useFadeIn(d);return <div style={s}>{children}</div>;}
function Card({children,style={}}){return <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.lg,...style}}>{children}</div>;}
function Tag({children,color,style={}}){return <span style={{display:"inline-flex",alignItems:"center",fontSize:10,fontWeight:500,color,background:`${color}12`,border:`1px solid ${color}33`,borderRadius:T.r.pill,padding:"4px 12px",letterSpacing:"0.08em",...style}}>{children}</span>;}
function StreakBadge({rhythm}){
  const completed = rhythm?.completed || 0;
  const expected  = rhythm?.expected  || 12;
  // If someone's going above the expected 3x/week, show "12+" rather than capping
  const over = completed > expected;
  const primary = over ? `${expected}+` : `${completed}`;
  const secondary = over ? "of 12 · strong" : `of ${expected}`;
  return (
    <div style={{background:T.bg2,border:`1px solid ${T.bg3}`,borderRadius:T.r.pill,padding:"8px 16px",display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontFamily:T.serif,fontSize:22,fontWeight:400,color:T.gold,lineHeight:1}}>{primary}</span>
      <div style={{fontSize:9,fontWeight:500,color:T.text3,letterSpacing:"0.1em",textTransform:"uppercase",lineHeight:1.5}}>{secondary}<br/>this month</div>
    </div>
  );
}
