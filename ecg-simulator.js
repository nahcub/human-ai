(function(){
  const SR = 200;
  const FPS = 60;
  const SAMPLES_PER_FRAME = Math.max(1, Math.round(SR / FPS));
  const MAX_BUFFER_SEC = 60;
  const MAX_BUFFER = MAX_BUFFER_SEC * SR;

  // Global state shared by all simulators
  let globalRunning = false;
  let globalDriftOn = false;
  let globalLeadOff = false;
  const globalUI = { hr:70, hrv:0.05, noise:0.01, amp:1.0, windowSec:6, brady:50, tachy:120, cvTh:0.12, stTh:0.12, noiseSens:0.60 };

  const simulators = [];
  const combinedAlerts = [];
  
  // Comprehensive event logging - only for significant events
  const eventLog = [];
  let sessionStartTime = Date.now();

  // Track drift state for each ECG channel to prevent duplicate logging
  const driftStates = [false, false, false, false]; // false = normal, true = drifting

  function logDetailedEvent(ecgIndex, eventType, data = {}) {
    const timestamp = Date.now();
    const relativeTime = (timestamp - sessionStartTime) / 1000; // seconds since session start
    
    const event = {
      timestamp: new Date(timestamp).toISOString(),
      relativeTime: relativeTime.toFixed(3),
      ecgChannel: ecgIndex + 1,
      eventType: eventType,
      data: data,
      sessionId: sessionStartTime
    };
    
    eventLog.push(event);
    
    // Keep memory usage reasonable
    if (eventLog.length > 10000) {
      eventLog.shift();
    }
  }

  function addECGPulseEffect(ecgIndex, severity) {
    const ecgCards = document.querySelectorAll('.ecg-card');
    const card = ecgCards[ecgIndex];
    if (!card) return;
    
    // Remove existing alert classes
    card.classList.remove('alert-pulse', 'alert-warning', 'alert-danger');
    
    // Add new alert classes
    card.classList.add('alert-pulse');
    if (severity === 2) {
      card.classList.add('alert-danger');
    } else {
      card.classList.add('alert-warning');
    }
    
    // Remove pulse effect after 3 seconds
    setTimeout(() => {
      card.classList.remove('alert-pulse');
    }, 3000);
  }

  function updateECGBorderColor(ecgIndex, severityLevel) {
    const ecgCards = document.querySelectorAll('.ecg-card');
    const card = ecgCards[ecgIndex];
    if (!card) return;
    
    // Remove existing alert classes
    card.classList.remove('alert-pulse', 'alert-warning', 'alert-danger');
    
    // Update border color based on severity
    const canvas = card.querySelector('canvas');
    if (canvas) {
      if (severityLevel === 0) {
        canvas.style.borderColor = '#1d2a40'; // Normal - dark blue
      } else if (severityLevel === 1) {
        canvas.style.borderColor = '#7a6139'; // Warning - yellow
        card.classList.add('alert-warning');
      } else if (severityLevel === 2) {
        canvas.style.borderColor = '#7a3946'; // Danger - red
        card.classList.add('alert-danger');
      }
    }
  }

  function createECGSimulator(root, ecgIndex){
    // State per instance - but controlled globally
    const severity = { level: 0 };

    let buffer = [];
    let bufferStartIndex = 0;
    let t = 0;
    let phase = 0;
    let sampleIndex = 0;
    let lastPhase = 0;
    let hrvState = 0.0;
    const rPeaks = [];
    const rrSec = [];
    const stEvents = [];
    const userMarks = [];
    const alerts = [];

    const refs = {
      severityPill: root.querySelector('.severityPill'),
      canvasHost: root.querySelector('.canvasHost')
    };

    function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
    function mean(arr){ if(!arr.length) return 0; return arr.reduce((a,b)=>a+b,0)/arr.length; }
    function std(arr){ if(arr.length<2) return 0; const m = mean(arr); const v = mean(arr.map(x => (x-m)*(x-m))); return Math.sqrt(v); }
    function gauss(x, mu, sigma, amp) { return amp * Math.exp(-0.5 * Math.pow((x - mu) / sigma, 2)); }
    function ecgTemplate(phase) {
      const P = gauss(phase, 0.18, 0.025, +0.10);
      const Q = gauss(phase, 0.38, 0.010, -0.15);
      const R = gauss(phase, 0.40, 0.015, +1.10);
      const S = gauss(phase, 0.43, 0.012, -0.25);
      const T = gauss(phase, 0.68, 0.05,  +0.30);
      return P + Q + R + S + T;
    }
    function baselineWander(t) { return 0.03 * Math.sin(2 * Math.PI * 0.33 * t); }
    function randomGaussian() { let u=0,v=0; while(u===0) u=Math.random(); while(v===0) v=Math.random(); return Math.sqrt(-2.0*Math.log(u))*Math.cos(2.0*Math.PI*v); }
    function updateHRV() { hrvState += 0.02 * randomGaussian(); hrvState = clamp(hrvState, -1, 1); return hrvState; }

    function pushSample(y){ buffer.push(y); sampleIndex++; if (buffer.length>MAX_BUFFER){ buffer.shift(); bufferStartIndex++; } }
    function getSampleAt(idx){ const i = idx - bufferStartIndex; if (i<0 || i>=buffer.length) return null; return buffer[i]; }

    function addAlert(msg, lvl=1){ 
      const timeStr = t.toFixed(1) + 's'; 
      const alertObj = {msg:`[ECG ${ecgIndex+1}] [${timeStr}] ${msg}`, lvl, ecg: ecgIndex+1, time: t};
      alerts.push(alertObj);
      combinedAlerts.push(alertObj);
      if (alerts.length>30) alerts.shift();
      if (combinedAlerts.length>100) combinedAlerts.shift();
      
      // Add pulse effect to ECG card
      addECGPulseEffect(ecgIndex, lvl);
      
      // Log detailed alert event (only abnormal events)
      logDetailedEvent(ecgIndex, 'ALERT', {
        message: msg,
        severity: lvl === 1 ? 'WARNING' : 'DANGER',
        simulationTime: t
      });
    }
    
    function logEvent(text){ 
      // Log detailed event (only abnormal events)
      logDetailedEvent(ecgIndex, 'EVENT', {
        description: text,
        simulationTime: t
      });
    }

    function evaluateBeat(rIdx){
      if (rPeaks.length>=2){ const rr=(rIdx - rPeaks[rPeaks.length-2])/SR; rrSec.push(rr); if (rrSec.length>50) rrSec.shift(); }
      const dtBaseline = Math.floor(0.20*SR);
      const dtST = Math.floor(0.08*SR);
      const baseIdx = rIdx - dtBaseline;
      const stIdx = rIdx + dtST;
      const baseY = getSampleAt(baseIdx);
      const stY = getSampleAt(stIdx);
      if (baseY!=null && stY!=null){
        const diff = (stY - baseY) * globalUI.amp;
        if (diff > globalUI.stTh){ 
          stEvents.push({idx:rIdx, type:'elev'}); 
          addAlert(`ST Elevation detected (Δ≈${diff.toFixed(2)})`, 2); 
          logEvent('ST Elevation');
          
          // Log only ST abnormalities
          logDetailedEvent(ecgIndex, 'ST_ABNORMAL', {
            type: 'ST_ELEVATION',
            sampleIndex: rIdx,
            simulationTime: t,
            stValue: diff
          });
        } else if (diff < -globalUI.stTh){ 
          stEvents.push({idx:rIdx, type:'depr'}); 
          addAlert(`ST Depression detected (Δ≈${diff.toFixed(2)})`, 2); 
          logEvent('ST Depression');
          
          // Log only ST abnormalities
          logDetailedEvent(ecgIndex, 'ST_ABNORMAL', {
            type: 'ST_DEPRESSION',
            sampleIndex: rIdx,
            simulationTime: t,
            stValue: diff
          });
        }
        // Don't log normal R-peaks
        if (stEvents.length>80) stEvents.shift();
      }
    }

    function estimateSignalQuality(){
      const N = Math.min(buffer.length, 2*SR);
      if (N<10) return {qual:'—', score:0};
      const k=5; const seg = buffer.slice(buffer.length-N);
      const smooth = new Array(N).fill(0);
      for (let i=0;i<N;i++){ let s=0,c=0; for (let j=-Math.floor(k/2); j<=Math.floor(k/2); j++){ const idx=i+j; if (idx<0||idx>=N) continue; s+=seg[idx]; c++; } smooth[i]=s/c; }
      const resid = seg.map((v,i)=> v - smooth[i]);
      const score = clamp(std(resid)/(std(seg)+1e-6), 0, 2);
      let qual='Good'; if (score>globalUI.noiseSens*1.2) qual='Poor'; else if (score>globalUI.noiseSens) qual='Fair';
      return {qual, score};
    }

    function evaluateRhythm(){
      const windowSec=10; const minIdx = sampleIndex - windowSec*SR;
      const recentR = rPeaks.filter(idx=> idx>=minIdx);
      const recentRR = []; for (let i=1;i<recentR.length;i++){ recentRR.push((recentR[i]-recentR[i-1])/SR); }
      const mRR = mean(recentRR);
      const avgHR = mRR>0 ? 60/mRR : 0;
      const cv = (mRR>0 && recentRR.length>=3) ? (std(recentRR)/mRR) : 0;
      let brady=false, tachy=false, afib=false;
      if (avgHR>0 && avgHR<globalUI.brady) brady=true;
      if (avgHR>0 && avgHR>globalUI.tachy) tachy=true;
      if (cv>globalUI.cvTh && recentRR.length>=5) afib=true;
      
      const stWin = stEvents.filter(e=> e.idx>=minIdx);
      let stState='Normal'; if (stWin.some(e=>e.type==='elev')) stState='Elevation'; else if (stWin.some(e=>e.type==='depr')) stState='Depression';
      
      if (brady) { addAlert(`Bradycardia (avg ~${avgHR.toFixed(0)} bpm)`, 1); logEvent('Bradycardia'); }
      if (tachy) { addAlert(`Tachycardia (avg ~${avgHR.toFixed(0)} bpm)`, 1); logEvent('Tachycardia'); }
      if (afib)  { addAlert(`Irregular rhythm (AFib-suspect: CV ${cv.toFixed(2)})`, 2); logEvent('AFib-suspect'); }
      
      let lvl=0; if (stState!=='Normal' || afib) lvl=2; else if (brady||tachy) lvl=1;
      const {qual, score} = estimateSignalQuality();
      if (globalLeadOff) lvl = Math.max(lvl, 2);
      severity.level = lvl;
      
      // Check if we should log rhythm abnormalities
      if (brady || tachy || afib || stState !== 'Normal' || qual === 'Poor') {
        logDetailedEvent(ecgIndex, 'RHYTHM_ABNORMAL', {
          heartRate: avgHR,
          hrVariability: cv,
          signalQuality: qual,
          signalScore: score,
          stState: stState,
          bradycardia: brady,
          tachycardia: tachy,
          irregularRhythm: afib,
          severityLevel: lvl,
          simulationTime: t
        });
      }
      
      // Update ECG border color based on severity
      updateECGBorderColor(ecgIndex, lvl);
      
      // Update individual ECG status pill
      const pill = refs.severityPill;
      if (lvl===0){ pill.textContent=`ECG ${ecgIndex+1}: NORMAL`; pill.style.color='#9bffc7'; pill.style.border='1px solid #2a705e'; pill.style.background='#0e1f22'; }
      if (lvl===1){ pill.textContent=`ECG ${ecgIndex+1}: WARNING`; pill.style.color='#ffd166'; pill.style.border='1px solid #7a6139'; pill.style.background='#211a0e'; }
      if (lvl===2){ pill.textContent=`ECG ${ecgIndex+1}: DANGER`; pill.style.color='#ff8b94'; pill.style.border='1px solid #7a3946'; pill.style.background='#211013'; }
    }

    // Reset function for this simulator
    function reset(){
      buffer=[]; bufferStartIndex=0; t=0; phase=0; sampleIndex=0; lastPhase=0;
      rPeaks.length=0; rrSec.length=0; stEvents.length=0; userMarks.length=0; alerts.length=0;
      
      // Reset drift state for this channel
      driftStates[ecgIndex] = false;
      
      // Reset border color to normal
      updateECGBorderColor(ecgIndex, 0);
      
      logDetailedEvent(ecgIndex, 'SYSTEM', {
        action: 'RESET',
        simulationTime: t
      });
    }

    // Mark event function for this simulator
    function markEvent(){
      userMarks.push({idx: sampleIndex});
      logEvent('User mark');
      
      logDetailedEvent(ecgIndex, 'USER_ACTION', {
        action: 'MARK_EVENT',
        sampleIndex: sampleIndex,
        simulationTime: t
      });
    }

    // p5 instance
    let canvasElt = null;
    const sketch = (p)=>{
      p.setup = function(){
        const host = refs.canvasHost;
        const w = Math.floor(host.clientWidth || 600);
        const h = Math.max(260, Math.floor((host.clientWidth||600) * 0.4));
        const cnv = p.createCanvas(w, h);
        canvasElt = cnv.elt;
        p.frameRate(FPS);
        p.strokeWeight(1.6);
        p.noFill();
      };

      p.windowResized = function(){
        const host = refs.canvasHost;
        const w = Math.floor(host.clientWidth || p.width);
        const h = Math.max(260, Math.floor((host.clientWidth||p.width) * 0.4));
        p.resizeCanvas(w, h);
      };

      function drawBackground(){
        p.background('#081020');
        // Border color is now handled in evaluateRhythm
      }

      function drawSignal(){
        const padX=20, padY=16;
        const H = p.height - 2*padY;
        const W = p.width - 2*padX;
        const winSamples = Math.max(10, Math.floor(globalUI.windowSec*SR));
        const startAbs = Math.max(bufferStartIndex, sampleIndex - winSamples);
        const startRel = startAbs - bufferStartIndex;
        const visible = buffer.slice(startRel);
        p.stroke(20,40,70);
        for (let i=0;i<=10;i++){ const y=padY + (i/10)*H; p.line(padX, y, padX+W, y); }
        let lineColor = '#53d1b6'; if (severity.level===1) lineColor='#ffd166'; if (severity.level===2) lineColor='#ff7a90';
        p.noFill(); p.stroke(lineColor); p.beginShape();
        for (let i=0;i<visible.length;i++){ const x=padX + (i/Math.max(1,visible.length-1))*W; const y=padY + H/2 - visible[i]*(H*0.38)*globalUI.amp; p.vertex(x,y); }
        p.endShape();
        const xOf=(absIdx)=>{ const rel=absIdx-startAbs; if (rel<0 || rel>=visible.length) return null; return padX + (rel/Math.max(1,visible.length-1))*W; };
        p.noStroke(); p.fill('#8be9fd');
        rPeaks.forEach(idx=>{ const x=xOf(idx); if (x===null) return; const y=padY + H/2 - (getSampleAt(idx)||0)*(H*0.38)*globalUI.amp; p.circle(x, y-6, 4); });
        stEvents.forEach(e=>{ const x=xOf(e.idx); if (x===null) return; const y=padY+12; p.fill(e.type==='elev'?'#ff7a90':'#ffd166'); p.rect(x-3,y-3,6,6,2); });
        userMarks.forEach(m=>{ const x=xOf(m.idx); if (x===null) return; p.stroke('#9bffb0'); p.noFill(); p.line(x, padY, x, padY+H); });
      }

      p.draw = function(){
        if (globalRunning){
          for (let k=0; k<SAMPLES_PER_FRAME; k++){
            const dt = 1.0/SR;
            if (globalLeadOff){ const y = 0 + globalUI.noise * randomGaussian() * 0.2; pushSample(y); t+=dt; continue; }
            const baseF = globalUI.hr/60.0; const hrvFactor = 1 + globalUI.hrv * updateHRV() * 0.2; let f = baseF * hrvFactor;
            
            // Drift detection with state tracking
            if (globalDriftOn && Math.random()<0.003){ 
              const phaseShift = -(0.15 + Math.random()*0.2);
              phase += phaseShift;
              
              // Only log drift event if this channel wasn't already drifting
              if (!driftStates[ecgIndex]) {
                driftStates[ecgIndex] = true; // Mark as drifting
                
                logDetailedEvent(ecgIndex, 'DRIFT_EVENT', {
                  phaseShift: phaseShift,
                  simulationTime: t,
                  driftEnabled: globalDriftOn,
                  currentPhase: phase,
                  driftState: 'STARTED'
                });
              }
            } else {
              // Check if drift has ended (no drift for a while)
              if (driftStates[ecgIndex] && Math.random() < 0.001) { // Lower probability for drift end
                driftStates[ecgIndex] = false; // Mark as normal
                
                logDetailedEvent(ecgIndex, 'DRIFT_EVENT', {
                  phaseShift: 0,
                  simulationTime: t,
                  driftEnabled: globalDriftOn,
                  currentPhase: phase,
                  driftState: 'ENDED'
                });
              }
            }
            
            lastPhase = phase; phase += f*dt; if (phase>=1) phase-=1;
            let y = ecgTemplate(phase); y += baselineWander(t); y += globalUI.noise * randomGaussian() * 0.1; pushSample(y); t+=dt;
            if (lastPhase<0.40 && phase>=0.40){ const rIdx = sampleIndex-1; rPeaks.push(rIdx); if (rPeaks.length>300) rPeaks.shift(); evaluateBeat(rIdx); }
          }
        }
        drawBackground();
        drawSignal();
        if (p.frameCount % Math.max(1, Math.floor(FPS/5)) === 0){ evaluateRhythm(); }
      };
    };

    new p5(sketch, refs.canvasHost);

    return { reset, markEvent };
  }

  function updateEventCounts(){
    document.getElementById('eventCount').textContent = eventLog.length;
    document.getElementById('alertCount').textContent = combinedAlerts.length;
  }

  function exportToCSV(){
    const headers = [
      'Timestamp',
      'Relative Time (s)',
      'ECG Channel',
      'Event Type',
      'Message/Description',
      'Severity',
      'Heart Rate',
      'HRV',
      'Signal Quality',
      'ST State',
      'Sample Index',
      'Simulation Time',
      'Additional Data'
    ];
    
    const rows = eventLog.map(event => {
      const data = event.data || {};
      return [
        event.timestamp,
        event.relativeTime,
        event.ecgChannel,
        event.eventType,
        data.message || data.description || data.action || data.type || '',
        data.severity || '',
        data.heartRate || '',
        data.hrVariability || '',
        data.signalQuality || '',
        data.stState || '',
        data.sampleIndex || '',
        data.simulationTime || '',
        JSON.stringify(data)
      ];
    });
    
    const csvContent = [headers, ...rows]
      .map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `ecg_drift_log_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function exportToJSON(){
    const exportData = {
      sessionInfo: {
        sessionId: sessionStartTime,
        sessionStart: new Date(sessionStartTime).toISOString(),
        exportTime: new Date().toISOString(),
        totalEvents: eventLog.length,
        totalAlerts: combinedAlerts.length,
        driftEventsOnly: true
      },
      configuration: globalUI,
      events: eventLog,
      summary: {
        eventTypes: [...new Set(eventLog.map(e => e.eventType))],
        channelsActive: [...new Set(eventLog.map(e => e.ecgChannel))],
        driftEventCount: eventLog.filter(e => e.eventType === 'DRIFT_EVENT').length,
        firstEvent: eventLog.length > 0 ? eventLog[0].timestamp : null,
        lastEvent: eventLog.length > 0 ? eventLog[eventLog.length - 1].timestamp : null
      }
    };
    
    const jsonContent = JSON.stringify(exportData, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `ecg_drift_log_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Master control functions
  function updateMasterStatus(){
    document.getElementById('masterStatus').textContent = globalRunning ? 'running' : 'paused';
    document.getElementById('masterDrift').textContent = (globalDriftOn ? '⚠️ Drift: ON' : '⚠️ Drift: OFF');
    document.getElementById('masterLead').textContent = (globalLeadOff ? '🔌 Lead-Off: ON' : '🔌 Lead-Off: OFF');
    
    // Log system state changes
    logDetailedEvent(-1, 'SYSTEM', {
      action: globalRunning ? 'START' : 'PAUSE',
      driftMode: globalDriftOn,
      leadOffMode: globalLeadOff,
      configuration: {...globalUI}
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    // Initialize session
    logDetailedEvent(-1, 'SYSTEM', {
      action: 'SESSION_START',
      configuration: {...globalUI}
    });

    // Create all simulators
    document.querySelectorAll('.ecg-card').forEach((root, index)=> {
      const sim = createECGSimulator(root, index);
      simulators.push(sim);
    });

    // Wire master controls (buttons only)
    document.getElementById('masterToggle').addEventListener('click', ()=>{ globalRunning=!globalRunning; updateMasterStatus(); });
    document.getElementById('masterReset').addEventListener('click', ()=>{ 
      simulators.forEach(sim=>sim.reset()); 
      combinedAlerts.length = 0;
      // Reset all drift states
      driftStates.fill(false);
      updateMasterStatus(); 
    });
    document.getElementById('masterDrift').addEventListener('click', ()=>{ globalDriftOn=!globalDriftOn; updateMasterStatus(); });
    document.getElementById('masterLead').addEventListener('click', ()=>{ globalLeadOff=!globalLeadOff; updateMasterStatus(); });
    document.getElementById('masterMark').addEventListener('click', ()=>{ simulators.forEach(sim=>sim.markEvent()); });

    // Wire export buttons
    document.getElementById('exportCSV').addEventListener('click', exportToCSV);
    document.getElementById('exportJSON').addEventListener('click', exportToJSON);

    // Update event counts periodically
    setInterval(()=>{
      updateEventCounts();
    }, 1000);

    updateMasterStatus();
  });
})(); 