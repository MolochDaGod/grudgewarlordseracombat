import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene2() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 100),
      setTimeout(() => setPhase(2), 600),
      setTimeout(() => setPhase(3), 1200),
      setTimeout(() => setPhase(4), 4000),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-between px-[10vw]"
      initial={{ opacity: 0, x: 100 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -100, filter: 'blur(10px)' }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-[40vw] z-10 flex flex-col items-start">
        <motion.div 
          className="h-[2px] bg-[#46d7ff] mb-6"
          initial={{ width: 0 }}
          animate={phase >= 1 ? { width: "10vw" } : { width: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
        
        <motion.h2 
          className="text-[5vw] font-display font-bold leading-tight uppercase"
          initial={{ opacity: 0, x: -50 }}
          animate={phase >= 2 ? { opacity: 1, x: 0 } : { opacity: 0, x: -50 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          Choose Your<br/><span className="text-[#46d7ff]">Champion</span>
        </motion.h2>
        
        <motion.p 
          className="text-[1.8vw] text-white/70 mt-6 font-body"
          initial={{ opacity: 0, y: 20 }}
          animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          24 heroes. Real 3D models.<br/>Embedded weapons.
        </motion.p>
      </div>

      <motion.div 
        className="relative w-[45vw] h-[70vh] flex items-center justify-center"
        initial={{ opacity: 0, scale: 0.8, rotateY: -30 }}
        animate={phase >= 2 ? { opacity: 1, scale: 1, rotateY: 0 } : { opacity: 0, scale: 0.8, rotateY: -30 }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
        style={{ perspective: 1000 }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/champion-select.png`} 
          alt="Champion Select" 
          className="w-full h-full object-cover rounded-xl border border-[#46d7ff]/30 shadow-[0_0_50px_rgba(70,215,255,0.2)]"
        />
        
        {/* Hologram scanline effect */}
        <motion.div 
          className="absolute top-0 left-0 w-full h-[5px] bg-[#46d7ff]/50 blur-sm mix-blend-screen"
          animate={{ top: ['0%', '100%'] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
        />
      </motion.div>
    </motion.div>
  );
}