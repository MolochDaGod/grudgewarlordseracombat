import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene4() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2000),
      setTimeout(() => setPhase(4), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center px-[5vw]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.5, filter: 'blur(20px)' }}
      transition={{ duration: 0.8 }}
    >
      <div className="w-full flex gap-12">
        {/* Mode 1: Survival */}
        <motion.div 
          className="flex-1 relative h-[60vh] border border-[#ef4444]/30 bg-black/40 backdrop-blur-md rounded-2xl overflow-hidden flex flex-col justify-end p-8"
          initial={{ opacity: 0, x: -50, rotateY: 20 }}
          animate={phase >= 1 ? { opacity: 1, x: 0, rotateY: 0 } : { opacity: 0, x: -50, rotateY: 20 }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
          style={{ perspective: 1000 }}
        >
          <motion.div className="absolute inset-0 bg-gradient-to-t from-[#ef4444]/20 to-transparent" />
          <h3 className="text-[3vw] font-display font-bold text-[#ef4444] uppercase tracking-wider relative z-10">Survival</h3>
          <p className="text-[1.5vw] font-body text-white/80 relative z-10 mt-2">5 Escalating Waves. One Victor.</p>
          
          {/* Animated red line */}
          <motion.div 
            className="absolute top-0 left-0 h-1 bg-[#ef4444]"
            initial={{ width: 0 }}
            animate={phase >= 1 ? { width: '100%' } : { width: 0 }}
            transition={{ duration: 2, delay: 0.5, ease: "linear" }}
          />
        </motion.div>

        {/* VS / Divider */}
        <motion.div 
          className="flex flex-col items-center justify-center z-20"
          initial={{ opacity: 0, scale: 0 }}
          animate={phase >= 2 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0 }}
          transition={{ type: "spring", stiffness: 200, damping: 15 }}
        >
          <div className="w-[2px] h-20 bg-white/20 mb-4" />
          <span className="font-display text-2xl text-white/50 uppercase">OR</span>
          <div className="w-[2px] h-20 bg-white/20 mt-4" />
        </motion.div>

        {/* Mode 2: Testing Grounds */}
        <motion.div 
          className="flex-1 relative h-[60vh] border border-[#10b981]/30 bg-black/40 backdrop-blur-md rounded-2xl overflow-hidden flex flex-col justify-end p-8"
          initial={{ opacity: 0, x: 50, rotateY: -20 }}
          animate={phase >= 3 ? { opacity: 1, x: 0, rotateY: 0 } : { opacity: 0, x: 50, rotateY: -20 }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
          style={{ perspective: 1000 }}
        >
          <motion.div className="absolute inset-0 bg-gradient-to-t from-[#10b981]/20 to-transparent" />
          <h3 className="text-[3vw] font-display font-bold text-[#10b981] uppercase tracking-wider relative z-10">Testing Grounds</h3>
          <p className="text-[1.5vw] font-body text-white/80 relative z-10 mt-2">Free-play Sandbox. No Limits.</p>
          
          {/* Animated green line */}
          <motion.div 
            className="absolute top-0 left-0 h-1 bg-[#10b981]"
            initial={{ width: 0 }}
            animate={phase >= 3 ? { width: '100%' } : { width: 0 }}
            transition={{ duration: 2, delay: 0.5, ease: "linear" }}
          />
        </motion.div>
      </div>
    </motion.div>
  );
}