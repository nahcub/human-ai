# ECG Simulation Tool

## Overview
This tool simulates ECG signals with various scenarios for analysis and alert testing.

## Features
- **Start/Pause**: Control the simulation.
- **Drift**: Introduces irregular RR intervals to simulate arrhythmia scenarios.
- **Lead-Off**: Simulates sensor detachment, resulting in flatline + noise.
- **Analysis & Alerts Panel**: Displays
  - Average HR  
  - RR Coefficient of Variation (CV)  
  - ST Status  
  - Signal Quality (SQI)  
  - Lead Status  
  - Recent Alerts

- **Mark Event**: Tag the moment of perceived symptoms. A vertical line will appear on the waveform, and an entry will be logged.

## Usage
1. Launch the simulation.
2. Use the **Start/Pause** button to begin or stop.  
3. Toggle **Drift** or **Lead-Off** to simulate abnormal conditions.  
4. Monitor real-time data and alerts on the right panel.  
5. Use **Mark Event** to record symptom occurrences for later analysis.

## Notes
- Designed for human–AI collaborative testing.  
- Supports arrhythmia and sensor error simulation.  
- Logs and waveform annotations enable detailed post-analysis.  
