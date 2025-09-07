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
  let fitbitIntervalId = null;
  
  // Track drift state for each ECG channel to prevent duplicate logging
  const driftStates = [false, false, false, false]; // false = normal, true = drifting

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
    // Detect if this is the Fitbit HRV card
    const isFitbitCard = root.id === 'fitbit-hrv-card';
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
      if (isFitbitCard) return; // Do not add alerts for Fitbit card
      const timeStr = t.toFixed(1) + 's'; 
      const alertObj = {msg:`[ECG ${ecgIndex+1}] [${timeStr}] ${msg}`, lvl, ecg: ecgIndex+1, time: t};
      alerts.push(alertObj);
      combinedAlerts.push(alertObj);
      if (alerts.length>30) alerts.shift();
      if (combinedAlerts.length>100) combinedAlerts.shift();
      
      // Add pulse effect to ECG card
      addECGPulseEffect(ecgIndex, lvl);
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
        } else if (diff < -globalUI.stTh){ 
          stEvents.push({idx:rIdx, type:'depr'}); 
          addAlert(`ST Depression detected (Δ≈${diff.toFixed(2)})`, 2); 
        }
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
      if (isFitbitCard) return; // Skip ECG logic for Fitbit card
      const windowSec=10; const minIdx = sampleIndex - windowSec*SR;
      const recentR = rPeaks.filter(idx=> idx>=minIdx);
      const recentRR = []; for (let i=1;i<recentR.length;i++){ recentRR.push((recentR[i]-recentR[i-1])/SR); }
      const mRR = mean(recentRR);
      const avgHR = mRR>0 ? 60/mRR : 0;
      const hrv = (mRR > 0 && recentRR.length >= 3) ? std(recentRR) * 1000 : 0;
      const cv = (mRR>0 && recentRR.length>=3) ? (std(recentRR)/mRR) : 0;
      let brady=false, tachy=false, afib=false;
      if (avgHR>0 && avgHR<globalUI.brady) brady=true;
      if (avgHR>0 && avgHR>globalUI.tachy) tachy=true;
      if (hrv > globalUI.cvTh && recentRR.length >= 5) afib = true;      
      if (cv>globalUI.cvTh && recentRR.length>=5) afib=true;
      
      const stWin = stEvents.filter(e=> e.idx>=minIdx);
      let stState='Normal'; if (stWin.some(e=>e.type==='elev')) stState='Elevation'; else if (stWin.some(e=>e.type==='depr')) stState='Depression';
      
      if (brady) { addAlert(`Bradycardia (avg ~${avgHR.toFixed(0)} bpm)`, 1); }
      if (tachy) { addAlert(`Tachycardia (avg ~${avgHR.toFixed(0)} bpm)`, 1); }
      if (afib)  { addAlert(`Irregular rhythm (AFib-suspect: CV ${cv.toFixed(2)})`, 2); }
      
      let lvl=0; if (stState!=='Normal' || afib) lvl=2; else if (brady||tachy) lvl=1;
      if (globalLeadOff) lvl = Math.max(lvl, 2);
      severity.level = lvl;
      
      // Update ECG border color based on severity
      updateECGBorderColor(ecgIndex, lvl);
      
      // Update individual ECG status pill
      const pill = refs.severityPill;
      if (lvl===0){ pill.textContent=`ECG ${ecgIndex+1}: NORMAL`; pill.style.color='#9bffc7'; pill.style.border='1px solid #2a705e'; pill.style.background='#0e1f22'; }
      if (lvl===1){ pill.textContent=`ECG ${ecgIndex+1}: WARNING`; pill.style.color='#ffd166'; pill.style.border='1px solid #7a6139'; pill.style.background='#211a0e'; }
      if (lvl===2){ pill.textContent=`ECG ${ecgIndex+1}: DANGER`; pill.style.color='#ff8b94'; pill.style.border='1px solid #7a3946'; pill.style.background='#211013'; }

      // Send data to AetherSense API
      if (avgHR > 0 && cv > 0) {
        const payload = {
          user_id: "simulator-user-123", // A placeholder ID
          breath_rate: avgHR,
          hrv: cv,
          text: `ECG ${ecgIndex + 1}: avgHR=${avgHR.toFixed(2)}, HRV=${hrv.toFixed(2)}`
        };

        fetch(`${AETHER_SENSE_URL}/breath-check-in`, {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        })
        .then(response => response.json())
        .then(data => console.log('Success:', data))
        .catch((error) => console.error('Error:', error));  
      }     
    }

    // Reset function for this simulator
    function reset(){
      buffer=[]; bufferStartIndex=0; t=0; phase=0; sampleIndex=0; lastPhase=0;
      rPeaks.length=0; rrSec.length=0; stEvents.length=0; userMarks.length=0; alerts.length=0;
      
      // Reset drift state for this channel
      driftStates[ecgIndex] = false;
      
      // Reset border color to normal
      updateECGBorderColor(ecgIndex, 0);
    }

    // Mark event function for this simulator
    function markEvent(){
      userMarks.push({idx: sampleIndex});
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
        if (!isFitbitCard && globalRunning){
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
              }
            } else {
              // Check if drift has ended (no drift for a while)
              if (driftStates[ecgIndex] && Math.random() < 0.001) { // Lower probability for drift end
                driftStates[ecgIndex] = false; // Mark as normal
              }
            }
            
            lastPhase = phase; phase += f*dt; if (phase>=1) phase-=1;
            let y = ecgTemplate(phase); y += baselineWander(t); y += globalUI.noise * randomGaussian() * 0.1; pushSample(y); t+=dt;
            if (lastPhase<0.40 && phase>=0.40){ const rIdx = sampleIndex-1; rPeaks.push(rIdx); if (rPeaks.length>300) rPeaks.shift(); evaluateBeat(rIdx); }
          }
          if (p.frameCount % Math.max(1, Math.floor(FPS/5)) === 0){ evaluateRhythm(); }
        }
        drawBackground();
        drawSignal();
      };
    };

    new p5(sketch, refs.canvasHost);

    // Expose pushSample for Fitbit HRV visual update
    return { reset, markEvent, pushSample };
  }

  // Master control functions
  function updateMasterStatus(){
    document.getElementById('masterStatus').textContent = globalRunning ? 'running' : 'paused';
    document.getElementById('masterDrift').textContent = (globalDriftOn ? ' Drift: ON' : ' Drift: OFF');
    document.getElementById('masterLead').textContent = (globalLeadOff ? ' Lead-Off: ON' : ' Lead-Off: OFF');
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    // Create all simulators
    document.querySelectorAll('.ecg-card').forEach((root, index)=> {
      const sim = createECGSimulator(root, index);
      simulators.push(sim);
    });

    const checkFitbitStatus = async () => {
      const connectBtn = document.getElementById('connectFitbit');
      const urlParams = new URLSearchParams(window.location.search);
      const redirectStatus = urlParams.get('fitbit_status');

      // --- Step 1: Handle immediate redirect from Fitbit ---
      if (redirectStatus) {
        if (redirectStatus === 'success') {
          // Immediately update the UI for a good user experience
          connectBtn.textContent = '✅ Fitbit Connected';
          connectBtn.disabled = true;
          connectBtn.style.cursor = 'default';
          connectBtn.style.borderColor = '#53d1b6';
        } else if (redirectStatus.startsWith('error')) {
          alert("Failed to connect to Fitbit. Please try again.");
        }
        // Clean the URL to prevent re-triggering this on refresh
        window.history.replaceState({}, document.title, window.location.pathname);
        return; // Exit after handling the redirect
      }

      try {
        const response = await fetch(AETHER_SENSE_URL + '/fitbit/status', {
          credentials: 'include'
        });
        const data = await response.json();
        
        if (data.status === 'connected') {
          connectBtn.textContent = '✅ Fitbit Connected';
          connectBtn.disabled = true;
          connectBtn.style.cursor = 'default';
        } else {
          connectBtn.textContent = '🔗 Connect to Fitbit';
          connectBtn.disabled = false;
        }
      } catch (error) {
        console.error("Could not check Fitbit status:", error);
        // Keep the button in its default "Connect" state if the backend is down
        connectBtn.textContent = '🔗 Connect to Fitbit';
        connectBtn.disabled = false;
      }
    };

    // Call the function when the page loads
    checkFitbitStatus();

    // Wire master controls (buttons only)
    document.getElementById('masterToggle').addEventListener('click', ()=>{
      globalRunning = !globalRunning;
      if (globalRunning) {
        // Start the ECG simulation
        console.log("Starting ECG simulation and Fitbit data fetch.");

        // Function to fetch and log Fitbit data
        const fetchAndLogFitbitData = () => {
          fetch(AETHER_SENSE_URL + '/fitbit/get-live-hrv', {
            method: 'GET',
            credentials: 'include'
          })
          .then(response => {
            if (!response.ok) {
              console.warn("Fitbit token might be expired or invalid. Please reconnect.");
              return null;
            }
            return response.json();
          })
          .then(data => {
            if (data && data.status === "success" && data.data.length > 0) {
              console.log('Successfully fetched Fitbit HRV data:', data.data);

              // 1. Transform the data for the backend
              const transformedData = data.data.map(entry => ({
                timestamp: entry.timestamp,
                signal: 'hrv', // Use a unique signal name for Fitbit data
                value: entry.hrv_value,
                unit: 'ms', // HRV is typically in milliseconds
                meta: { source: 'fitbit' }
              }));

              // 2. POST the transformed data to the backend's upload endpoint
              fetch(AETHER_SENSE_URL + '/ecg/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(transformedData)
              })
              .then(uploadResponse => {
                if (!uploadResponse.ok) {
                  return uploadResponse.json().then(err => { throw err; });
                }
                return uploadResponse.json();
              })
              .then(uploadResult => {
                console.log('Successfully logged Fitbit data to backend:', uploadResult);
              })
              .catch(error => {
                console.error('Error logging Fitbit data to backend:', error);
              });

              // 3. Update the dedicated Fitbit chart on the UI
              updateFitbitVisuals(data.data);

            } else {
              console.log('No new Fitbit data or an error occurred.');
            }
          })
          .catch(error => {
            console.error('Error fetching Fitbit data:', error);
          });
        };

        // Fetch immediately and then start the interval
        fetchAndLogFitbitData();
        fitbitIntervalId = setInterval(fetchAndLogFitbitData, 600); // Fetch every 60 seconds

      } else {
        console.log("Pausing ECG simulation and Fitbit data fetch.");
        // Stop fetching Fitbit data
        if (fitbitIntervalId) {
          clearInterval(fitbitIntervalId);
          fitbitIntervalId = null;
        }
      }
      updateMasterStatus();
    });
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
    document.getElementById('connectFitbit').addEventListener('click', ()=>{ window.location.href = AETHER_SENSE_URL + '/fitbit/login'; });
    updateMasterStatus();
  });

  function updateFitbitVisuals(hrvData) {
    // The Fitbit HRV card is the third .ecg-card (index 2)
    const ecgCards = document.querySelectorAll('.ecg-card');
    let fitbitIndex = -1;
    ecgCards.forEach((card, idx) => {
      if (card.id === 'fitbit-hrv-card') fitbitIndex = idx;
    });
    if (fitbitIndex === -1) {
      return;
    }
    const fitbitHrvSimulator = simulators[fitbitIndex];
    const fitbitHrvPill = document.querySelector('#fitbit-hrv-card .severityPill');
    
    if (fitbitHrvSimulator && hrvData.length > 0) {
      const latestHrv = hrvData[hrvData.length - 1].hrv_value;
      if (fitbitHrvPill) {
        fitbitHrvPill.textContent = `FITBIT HRV: ${latestHrv.toFixed(0)} ms`;
      }
      const normalizedValue = latestHrv / 100.0;
      if (typeof fitbitHrvSimulator.pushSample === 'function') {
        fitbitHrvSimulator.pushSample(normalizedValue);
      }
    }
  }

})(); 
