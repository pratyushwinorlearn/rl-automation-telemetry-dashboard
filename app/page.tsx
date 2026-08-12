"use client";
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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

export default function Dashboard() {
  const [data, setData] = useState<MetricRow[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      const { data: metrics } = await supabase
        .from('training_metrics')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(100);
      
      if (metrics) setData(metrics);
    };

    fetchData();
    // Refresh the graph every 10 seconds
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8 }}
      className="min-h-screen bg-gray-950 text-white p-4 font-sans"
    >
      <h1 className="text-2xl font-bold mb-2 text-green-400">Manny Telemetry</h1>
      <p className="text-gray-400 mb-8 text-sm">Live Multimodal Fusion Tracking</p>

      <div className="bg-gray-900 rounded-xl p-4 shadow-lg border border-gray-800">
        <h2 className="text-lg font-semibold mb-4">Win Rate vs. Exploration (Epsilon)</h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="step" stroke="#888" fontSize={12} tickFormatter={(tick) => `${(tick/1000).toFixed(1)}k`} />
              <YAxis yAxisId="left" stroke="#4ade80" fontSize={12} domain={[0, 100]} />
              <YAxis yAxisId="right" orientation="right" stroke="#f472b6" fontSize={12} domain={[0, 1]} />
              <Tooltip contentStyle={{ backgroundColor: '#111', borderColor: '#333' }} />
              
              <Line yAxisId="left" type="monotone" dataKey="win_rate" stroke="#4ade80" strokeWidth={3} dot={false} name="Win Rate (%)" />
              <Line yAxisId="right" type="monotone" dataKey="epsilon" stroke="#f472b6" strokeWidth={2} dot={false} name="Epsilon" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
}