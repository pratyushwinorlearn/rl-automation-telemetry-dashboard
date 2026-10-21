"use client";
import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { motion } from 'framer-motion';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

interface MetricRow {
  step: number;
  win_rate: number;
  loss: number;
  epsilon: number;
  phase: number;
  created_at?: string;
}

interface PhaseDiagnostics {
  phase: number;
  rawRows: MetricRow[];
  cleanRows: MetricRow[];
  startStep: number;
  endStep: number;
  totalStepsInPhase: number;
  activeTimeFormatted: string;
  activeMinutes: number;
  peakWinRate: number;
  peakWinStep: number;
  finalWinRate: number;
  avgWinRate: number;
  avgLoss: number;
  maxLoss: number;
  maxLossStep: number;
  startEpsilon: number;
  endEpsilon: number;
  adrenalineSpikes: { step: number; from: number; to: number }[];
  rewireRetries: number;
  narrative: string;
}

// ============================================================
// HELPER 1: SMART ACTIVE TRAINING TIME CALCULATOR
// Ignores gaps > 10 minutes (when training was stopped/paused)
// ============================================================
function calculateActiveTime(rows: MetricRow[]): { formatted: string; minutes: number } {
  const timestamps = rows
    .map((r) => (r.created_at ? new Date(r.created_at).getTime() : NaN))
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) {
    return { formatted: "< 1m", minutes: 0 };
  }

  const MAX_GAP_MS = 10 * 60 * 1000;
  let activeMs = 0;

  for (let i = 1; i < timestamps.length; i++) {
    const delta = timestamps[i] - timestamps[i - 1];
    if (delta > 0 && delta <= MAX_GAP_MS) {
      activeMs += delta;
    }
  }

  const totalMinutes = Math.max(1, Math.round(activeMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  if (hours > 0) {
    return { formatted: `${hours}h ${mins}m`, minutes: totalMinutes };
  }
  return { formatted: `${mins}m`, minutes: totalMinutes };
}

// ============================================================
// HELPER 2: UNTANGLE OVERLAPPING CHECKPOINT RETRIES
// Removes backward step loops so X-axis flows cleanly left-to-right
// ============================================================
function cleanPhaseTrajectory(rows: MetricRow[]): {
  cleaned: MetricRow[];
  retriesRemoved: number;
} {
  if (rows.length === 0) return { cleaned: [], retriesRemoved: 0 };

  const sortedSteps = [...rows].map((r) => r.step).sort((a, b) => a - b);
  const medianStep = sortedSteps[Math.floor(sortedSteps.length / 2)] || 0;
  const filteredGlitches =
    medianStep > 100_000 ? rows.filter((r) => r.step > 10_000) : rows;

  const keptReverse: MetricRow[] = [];
  let minStepSeen = Infinity;
  let retriesRemoved = 0;

  for (let i = filteredGlitches.length - 1; i >= 0; i--) {
    const row = filteredGlitches[i];
    if (row.step < minStepSeen) {
      keptReverse.push(row);
      minStepSeen = row.step;
    } else {
      retriesRemoved++;
    }
  }

  return {
    cleaned: keptReverse.reverse(),
    retriesRemoved,
  };
}

// ============================================================
// HELPER 3: GENERATE WRITTEN PHASE INTELLIGENCE LOG
// ============================================================
function buildPhaseDiagnostics(phase: number, rawRows: MetricRow[]): PhaseDiagnostics {
  const { cleaned, retriesRemoved } = cleanPhaseTrajectory(rawRows);
  const targetRows = cleaned.length > 5 ? cleaned : rawRows;

  const startStep = targetRows[0]?.step ?? 0;
  const endStep = targetRows[targetRows.length - 1]?.step ?? 0;
  const totalStepsInPhase = Math.max(0, endStep - startStep);

  const { formatted: activeTimeFormatted, minutes: activeMinutes } =
    calculateActiveTime(rawRows);

  let peakWinRate = 0;
  let peakWinStep = startStep;
  let maxLoss = 0;
  let maxLossStep = startStep;
  let winSum = 0;
  let lossSum = 0;

  const adrenalineSpikes: { step: number; from: number; to: number }[] = [];

  for (let i = 0; i < targetRows.length; i++) {
    const r = targetRows[i];
    winSum += r.win_rate;
    lossSum += r.loss;

    if (r.win_rate >= peakWinRate) {
      peakWinRate = r.win_rate;
      peakWinStep = r.step;
    }
    if (r.loss > maxLoss) {
      maxLoss = r.loss;
      maxLossStep = r.step;
    }

    if (i > 0) {
      const prevEps = targetRows[i - 1].epsilon;
      if (r.epsilon - prevEps >= 0.08) {
        adrenalineSpikes.push({
          step: r.step,
          from: prevEps,
          to: r.epsilon,
        });
      }
    }
  }

  const count = Math.max(1, targetRows.length);
  const avgWinRate = Number((winSum / count).toFixed(1));
  const avgLoss = Number((lossSum / count).toFixed(4));
  const finalWinRate = targetRows[targetRows.length - 1]?.win_rate ?? 0;
  const startEpsilon = targetRows[0]?.epsilon ?? 1.0;
  const endEpsilon = targetRows[targetRows.length - 1]?.epsilon ?? 0.05;

  const spanStr = `${(startStep / 1000).toFixed(1)}k to ${(endStep / 1000).toFixed(1)}k steps (+${(
    totalStepsInPhase / 1000
  ).toFixed(1)}k steps)`;

  let spikeText =
    adrenalineSpikes.length > 0
      ? `Injected ${adrenalineSpikes.length} manual Adrenaline Spike${
          adrenalineSpikes.length > 1 ? "s" : ""
        } (Epsilon resets up to ${(
          Math.max(...adrenalineSpikes.map((s) => s.to)) * 100
        ).toFixed(0)}%) to break Manny out of shadow-freezing and force exploration around new pillar and guard timings.`
      : `Epsilon decayed smoothly from ${(startEpsilon * 100).toFixed(1)}% down to ${(
          endEpsilon * 100
        ).toFixed(1)}% without requiring manual exploration overrides.`;

  let statusText = "";
  if (peakWinRate >= 85 && finalWinRate >= 65) {
    statusText = `Manny mastered this waypoint layout, peaking at a ${peakWinRate.toFixed(
      1
    )}% win rate at step ${(peakWinStep / 1000).toFixed(1)}k and stabilizing at ${finalWinRate.toFixed(
      1
    )}%.`;
  } else if (peakWinRate >= 75 && finalWinRate < 60) {
    statusText = `Manny reached a high of ${peakWinRate.toFixed(
      1
    )}% at step ${(peakWinStep / 1000).toFixed(
      1
    )}k, followed by a late-phase dip to ${finalWinRate.toFixed(
      1
    )}% after a layout or curriculum adjustment forced policy rewiring.`;
  } else {
    statusText = `High-difficulty obstacle zone: peaked at ${peakWinRate.toFixed(
      1
    )}% (step ${(peakWinStep / 1000).toFixed(1)}k) and finished at ${finalWinRate.toFixed(1)}%.`;
  }

  const narrative = `Trained across ${spanStr} over ${activeTimeFormatted} of active compute. ${statusText} ${spikeText} Neural network gradients peaked at a Huber Loss of ${maxLoss.toFixed(
    3
  )} around step ${(maxLossStep / 1000).toFixed(1)}k during spatial adaptation.`;

  return {
    phase,
    rawRows,
    cleanRows: targetRows,
    startStep,
    endStep,
    totalStepsInPhase,
    activeTimeFormatted,
    activeMinutes,
    peakWinRate,
    peakWinStep,
    finalWinRate,
    avgWinRate,
    avgLoss,
    maxLoss,
    maxLossStep,
    startEpsilon,
    endEpsilon,
    adrenalineSpikes,
    rewireRetries: retriesRemoved,
    narrative,
  };
}

// Accepts a raw YouTube video ID or common YouTube video/live URLs.
function extractYouTubeVideoId(value: string): string {
  const input = value.trim();
  if (!input) return "";

  // A direct YouTube video ID is normally 11 characters.
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;

  try {
    const normalized = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(input)
      ? input
      : `https://${input}`;
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    let candidate = "";

    if (host === "youtu.be") {
      candidate = parts[0] ?? "";
    } else if (
      host === "youtube.com" ||
      host === "youtube-nocookie.com" ||
      host === "studio.youtube.com"
    ) {
      candidate = url.searchParams.get("v") ?? "";

      if (!candidate) {
        const videoRoute = parts.findIndex((part) =>
          ["live", "embed", "shorts", "v"].includes(part.toLowerCase())
        );
        if (videoRoute >= 0) candidate = parts[videoRoute + 1] ?? "";
      }

      // Also support YouTube Studio URLs such as /video/VIDEO_ID/livestreaming.
      if (!candidate) {
        const videoRoute = parts.findIndex((part) => part.toLowerCase() === "video");
        if (videoRoute >= 0) candidate = parts[videoRoute + 1] ?? "";
      }
    }

    return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : "";
  } catch {
    return "";
  }
}

export default function Dashboard() {
  const [data, setData] = useState<MetricRow[]>([]);
  const [cleanMode, setCleanMode] = useState<boolean>(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  // YouTube stream panel state. The saved ID is local to this browser.
  const [streamId, setStreamId] = useState<string>(
    process.env.NEXT_PUBLIC_YOUTUBE_STREAM_ID || ""
  );
  const [streamInput, setStreamInput] = useState<string>(
    process.env.NEXT_PUBLIC_YOUTUBE_STREAM_ID || ""
  );
  const [showStream, setShowStream] = useState<boolean>(true);
  const [streamError, setStreamError] = useState<string>("");

  useEffect(() => {
    try {
      const savedId = window.localStorage.getItem("manny_stream_id");
      if (savedId) {
        setStreamId(savedId);
        setStreamInput(savedId);
      }
    } catch {
      // localStorage can be unavailable in some browser/privacy contexts.
    }
  }, []);

  const handleSaveStreamId = () => {
    const cleanId = extractYouTubeVideoId(streamInput);

    if (!cleanId) {
      setStreamError(
        "Enter an 11-character YouTube video ID or a valid YouTube watch/live URL."
      );
      return;
    }

    setStreamId(cleanId);
    setStreamInput(cleanId);
    setStreamError("");

    try {
      window.localStorage.setItem("manny_stream_id", cleanId);
    } catch {
      setStreamError(
        "Stream loaded, but this browser did not allow saving it for next time."
      );
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      const { data: metrics } = await supabase
        .from('training_metrics')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10000);

      if (metrics) {
        setData(metrics.reverse());
        setLastUpdated(new Date().toLocaleTimeString());
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const { phaseDiagnostics, globalStats } = useMemo(() => {
    const grouped = data.reduce((acc, row) => {
      if (!acc[row.phase]) acc[row.phase] = [];
      acc[row.phase].push(row);
      return acc;
    }, {} as Record<number, MetricRow[]>);

    const sortedPhaseNums = Object.keys(grouped)
      .map(Number)
      .sort((a, b) => a - b);

    const diagnostics = sortedPhaseNums.map((p) =>
      buildPhaseDiagnostics(p, grouped[p])
    );

    const totalSteps = data.length > 0 ? Math.max(...data.map((r) => r.step)) : 0;
    const allTimePeakWin =
      data.length > 0 ? Math.max(...data.map((r) => r.win_rate)) : 0;
    const latestRow = data[data.length - 1];
    const totalActive = calculateActiveTime(data);

    return {
      phaseDiagnostics: diagnostics,
      globalStats: {
        totalSteps,
        allTimePeakWin,
        currentWinRate: latestRow?.win_rate ?? 0,
        currentEpsilon: latestRow?.epsilon ?? 0,
        currentLoss: latestRow?.loss ?? 0,
        currentPhase: latestRow?.phase ?? 1,
        totalActiveTime: totalActive.formatted,
        totalCheckpoints: data.length,
      },
    };
  }, [data]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="min-h-screen bg-black text-zinc-100 p-4 md:p-8 font-sans selection:bg-emerald-500/30"
    >
      <div className="max-w-7xl mx-auto space-y-8">
        {/* 1. HEADER & CONTROLS */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-900 pb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-emerald-400">
                Manny Telemetry
              </h1>
              <span className="text-xs font-mono uppercase px-2.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                UE5 + PyTorch DQN
              </span>
            </div>
            <p className="text-zinc-400 mt-1 text-sm">
              Multimodal Sensor Fusion (4-Frame CNN + 80-Ray LiDAR) | Curriculum Stealth Agent
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setCleanMode(!cleanMode)}
              className={`px-3.5 py-2 rounded-lg text-xs font-medium border transition-all ${
                cleanMode
                  ? "bg-emerald-950/60 border-emerald-500/40 text-emerald-300"
                  : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {cleanMode ? "Graph Mode: Untangled (Clean)" : "Graph Mode: Raw Chronological"}
            </button>

            {lastUpdated && (
              <span className="text-xs text-zinc-500 font-mono">
                Synced: {lastUpdated}
              </span>
            )}
          </div>
        </div>

        {/* LIVE ARENA & CNN FUSION STREAM */}
        <section className="bg-zinc-950 border border-zinc-900 rounded-2xl p-5 shadow-2xl space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-zinc-900 pb-4">
            <div>
              <h2 className="text-lg font-bold text-emerald-400">
                Live Arena &amp; CNN Sensor Fusion Feed
              </h2>
              <p className="text-xs text-zinc-500 mt-1">
                UE5 spectator feed streamed through OBS · YouTube Live DVR (when enabled)
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={streamInput}
                onChange={(event) => {
                  setStreamInput(event.target.value);
                  if (streamError) setStreamError("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") handleSaveStreamId();
                }}
                placeholder="Paste YouTube Live URL or video ID"
                aria-label="YouTube video URL or ID"
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono focus:outline-none focus:border-emerald-500 w-full sm:w-64"
              />
              <button
                type="button"
                onClick={handleSaveStreamId}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-emerald-950/80 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/60 transition-all"
              >
                Load Stream
              </button>
              <button
                type="button"
                onClick={() => setShowStream((visible) => !visible)}
                aria-expanded={showStream}
                className="px-3 py-2 rounded-lg text-xs font-medium bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all"
              >
                {showStream ? "Hide Feed" : "Show Feed"}
              </button>
            </div>
          </div>

          {streamError && (
            <p role="alert" className="text-xs text-amber-300">
              {streamError}
            </p>
          )}

          {showStream && (
            <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border border-zinc-900 flex items-center justify-center">
              {streamId ? (
                <iframe
                  key={streamId}
                  src={`https://www.youtube.com/embed/${streamId}?autoplay=1&mute=1&playsinline=1`}
                  title="Unreal Engine RL live arena stream"
                  className="absolute inset-0 h-full w-full border-0"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              ) : (
                <div className="px-4 text-center">
                  <p className="text-sm text-zinc-400">No stream loaded</p>
                  <p className="text-xs text-zinc-600 mt-1">
                    Paste the YouTube live/watch URL or video ID above. The stream must be live or available to this viewer.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2. GLOBAL KPI BENTO GRID */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Total Steps</p>
            <p className="text-xl md:text-2xl font-bold text-white mt-1">
              {(globalStats.totalSteps / 1_000_000).toFixed(2)}M
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {globalStats.totalSteps.toLocaleString()} frames
            </p>
          </div>

          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Active Compute</p>
            <p className="text-xl md:text-2xl font-bold text-emerald-400 mt-1">
              {globalStats.totalActiveTime}
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Excludes offline pauses
            </p>
          </div>

          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Peak Win Rate</p>
            <p className="text-xl md:text-2xl font-bold text-emerald-400 mt-1">
              {globalStats.allTimePeakWin.toFixed(1)}%
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              100-episode rolling max
            </p>
          </div>

          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Latest Win Rate</p>
            <p className="text-xl md:text-2xl font-bold text-white mt-1">
              {globalStats.currentWinRate.toFixed(1)}%
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Phase {globalStats.currentPhase} active
            </p>
          </div>

          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Exploration (Eps)</p>
            <p className="text-xl md:text-2xl font-bold text-pink-400 mt-1">
              {(globalStats.currentEpsilon * 100).toFixed(1)}%
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Eps = {globalStats.currentEpsilon.toFixed(3)}
            </p>
          </div>

          <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-4">
            <p className="text-xs text-zinc-500 uppercase font-mono">Huber Loss</p>
            <p className="text-xl md:text-2xl font-bold text-sky-400 mt-1">
              {globalStats.currentLoss.toFixed(4)}
            </p>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {globalStats.totalCheckpoints.toLocaleString()} telemetry logs
            </p>
          </div>
        </div>

        {/* 3. SYSTEM ARCHITECTURE SPEC BAR */}
        <div className="bg-zinc-950/90 border border-zinc-900 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 text-xs text-zinc-400">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-200 font-semibold">Brain Architecture:</span>
            <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800">
              Head A: 3-Layer CNN (4x128x128 Grayscale Stack)
            </span>
            <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800">
              Head B: 2-Layer MLP (80 LiDAR Rays)
            </span>
            <span className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800">
              Fusion Core: 256-Unit Dense to 5 Discrete Actions
            </span>
          </div>
          <div className="font-mono text-zinc-500">
            Replay Buffer: 40,000 | Batch: 32 | Gamma: 0.99
          </div>
        </div>

        {/* 4. PER-PHASE GRAPHS + WRITTEN INTELLIGENCE LOGS */}
        <div className="space-y-10">
          {phaseDiagnostics.length === 0 ? (
            <div className="bg-zinc-950 border border-zinc-900 rounded-xl p-12 text-center text-zinc-500 italic">
              Waiting for telemetry data from Supabase...
            </div>
          ) : (
            phaseDiagnostics.map((diag, index) => {
              const chartData = cleanMode ? diag.cleanRows : diag.rawRows;

              return (
                <motion.div
                  key={diag.phase}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: index * 0.08 }}
                  className="bg-zinc-950 rounded-2xl p-5 md:p-6 shadow-2xl border border-zinc-900 space-y-6"
                >
                  {/* Phase Card Header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-900 pb-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <h2 className="text-lg md:text-xl font-bold text-blue-400">
                          Phase {diag.phase} Performance
                        </h2>
                        <span className="text-xs px-2.5 py-0.5 rounded bg-blue-950/60 border border-blue-800/50 text-blue-300 font-mono">
                          {(diag.startStep / 1000).toFixed(1)}k to {(diag.endStep / 1000).toFixed(1)}k steps
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 mt-1">
                        Active Time: <span className="text-zinc-300 font-medium">{diag.activeTimeFormatted}</span> |
                        Peak Win Rate: <span className="text-emerald-400 font-medium"> {diag.peakWinRate.toFixed(1)}%</span> |
                        Adrenaline Spikes: <span className="text-pink-400 font-medium"> {diag.adrenalineSpikes.length}</span>
                      </p>
                    </div>

                    {cleanMode && diag.rewireRetries > 0 && (
                      <span className="text-[11px] text-zinc-500 font-mono bg-zinc-900/80 px-2.5 py-1 rounded border border-zinc-800">
                        Filtered {diag.rewireRetries} overlapped retry points
                      </span>
                    )}
                  </div>

                  {/* Charts Grid: Win Rate/Epsilon (Left) + Huber Loss (Right) */}
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* MAIN CHART: WIN RATE & EPSILON */}
                    <div className="lg:col-span-2 bg-black/60 border border-zinc-900 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          Win Rate (%) vs. Exploration Epsilon
                        </span>
                        <div className="flex items-center gap-4 text-xs font-mono">
                          <span className="text-emerald-400">[Win Rate]</span>
                          <span className="text-pink-400">[Epsilon]</span>
                        </div>
                      </div>

                      <div className="h-64 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#18181b" />
                            <XAxis
                              type="number"
                              dataKey="step"
                              domain={['dataMin', 'dataMax']}
                              stroke="#52525b"
                              fontSize={11}
                              tickFormatter={(tick) => `${(tick / 1000).toFixed(0)}k`}
                            />
                            <YAxis
                              yAxisId="left"
                              stroke="#4ade80"
                              fontSize={11}
                              domain={[0, 100]}
                            />
                            <YAxis
                              yAxisId="right"
                              orientation="right"
                              stroke="#f472b6"
                              fontSize={11}
                              domain={[0, 1]}
                            />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#09090b',
                                borderColor: '#27272a',
                                fontSize: '12px',
                              }}
                              labelFormatter={(label) =>
                                `Step: ${Number(label).toLocaleString()}`
                              }
                            />
                            <Line
                              yAxisId="left"
                              type="monotone"
                              dataKey="win_rate"
                              stroke="#4ade80"
                              strokeWidth={2.5}
                              dot={false}
                              name="Win Rate (%)"
                            />
                            <Line
                              yAxisId="right"
                              type="monotone"
                              dataKey="epsilon"
                              stroke="#f472b6"
                              strokeWidth={2}
                              dot={false}
                              name="Epsilon"
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* SECONDARY CHART: NEURAL NETWORK LOSS */}
                    <div className="bg-black/60 border border-zinc-900 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                          Neural Network Huber Loss
                        </span>
                        <span className="text-xs text-sky-400 font-mono">
                          Avg: {diag.avgLoss}
                        </span>
                      </div>

                      <div className="h-64 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#18181b" />
                            <XAxis
                              type="number"
                              dataKey="step"
                              domain={['dataMin', 'dataMax']}
                              stroke="#52525b"
                              fontSize={11}
                              tickFormatter={(tick) => `${(tick / 1000).toFixed(0)}k`}
                            />
                            <YAxis stroke="#38bdf8" fontSize={11} />
                            <Tooltip
                              contentStyle={{
                                backgroundColor: '#09090b',
                                borderColor: '#27272a',
                                fontSize: '12px',
                              }}
                              labelFormatter={(label) =>
                                `Step: ${Number(label).toLocaleString()}`
                              }
                            />
                            <Area
                              type="monotone"
                              dataKey="loss"
                              stroke="#38bdf8"
                              fill="#0284c7"
                              fillOpacity={0.2}
                              strokeWidth={1.5}
                              name="Huber Loss"
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>

                  {/* WRITTEN ANALYSIS BELOW GRAPH */}
                  <div className="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                        Phase {diag.phase} Written Intelligence Breakdown
                      </h3>
                      <span className="text-[11px] font-mono text-zinc-500">
                        {diag.cleanRows.length} clean checkpoints analyzed
                      </span>
                    </div>

                    <p className="text-sm text-zinc-300 leading-relaxed">
                      {diag.narrative}
                    </p>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-zinc-800/60 text-xs">
                      <div>
                        <span className="text-zinc-500 block">Step Span</span>
                        <span className="text-zinc-200 font-mono">
                          +{(diag.totalStepsInPhase / 1000).toFixed(1)}k steps ({diag.activeTimeFormatted})
                        </span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block">Win Rate Trajectory</span>
                        <span className="text-zinc-200 font-mono">
                          Peak {diag.peakWinRate.toFixed(1)}% to Final {diag.finalWinRate.toFixed(1)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block">Exploration Decay</span>
                        <span className="text-zinc-200 font-mono">
                          Eps {diag.startEpsilon.toFixed(2)} to {diag.endEpsilon.toFixed(2)} ({diag.adrenalineSpikes.length} spikes)
                        </span>
                      </div>
                      <div>
                        <span className="text-zinc-500 block">Peak Gradient Rewiring</span>
                        <span className="text-zinc-200 font-mono">
                          Loss {diag.maxLoss.toFixed(3)} @ {(diag.maxLossStep / 1000).toFixed(1)}k
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </motion.div>
  );
}