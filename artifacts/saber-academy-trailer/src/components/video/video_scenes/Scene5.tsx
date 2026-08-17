import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene5() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 500),
      setTimeout(() => setPhase(2), 1500),
      setTimeout(() => setPhase(3), 2500),
      setTimeout(() => setPhase(4), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 1 }}
    >
      {/* Central glowing orb */}
      <motion.div 
        className="absolute w-[30vw] h-[30vw] rounded-full bg-[#46d7ff] mix-blend-screen blur-[100px]"
        initial={{ scale: 0, opacity: 0 }}
        animate={phase >= 1 ? { scale: 1, opacity: 0.3 } : { scale: 0, opacity: 0 }}
        transition={{ duration: 2, ease: "easeOut" }}
      />

      <div className="relative z-10 flex flex-col items-center">
        <motion.div
          className="text-[8vw] font-display font-black text-white uppercase tracking-tighter flex gap-4 drop-shadow-[0_0_20px_rgba(70,215,255,0.6)]"
        >
          <motion.span
            initial={{ opacity: 0, x: -100 }}
            animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -100 }}
            transition={{ type: "spring", stiffness: 100, damping: 20 }}
          >
            Saber
          </motion.span>
          <motion.span
            className="text-[#46d7ff]"
            initial={{ opacity: 0, x: 100 }}
            animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: 100 }}
            transition={{ type: "spring", stiffness: 100, damping: 20 }}
          >
            Academy
          </motion.span>
        </motion.div>

        <motion.div 
          className="mt-6 flex flex-col items-center"
          initial={{ opacity: 0, y: 30 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8 }}
        >
          <div className="h-[1px] w-[20vw] bg-gradient-to-r from-transparent via-[#46d7ff] to-transparent mb-6" />
          <p className="text-[2vw] font-body font-bold text-white tracking-widest uppercase">
            Play Now in Browser
          </p>
        </motion.div>
      </div>

      {/* Cinematic letterbox overlay */}
      <motion.div 
        className="absolute top-0 w-full bg-black z-20"
        initial={{ height: "0vh" }}
        animate={phase >= 1 ? { height: "10vh" } : { height: "0vh" }}
        transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
      />
      <motion.div 
        className="absolute bottom-0 w-full bg-black z-20"
        initial={{ height: "0vh" }}
        animate={phase >= 1 ? { height: "10vh" } : { height: "0vh" }}
        transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1] }}
      />
    </motion.div>
  );
}