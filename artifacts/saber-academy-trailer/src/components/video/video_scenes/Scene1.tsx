import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene1() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 1000),
      setTimeout(() => setPhase(3), 2000),
      setTimeout(() => setPhase(4), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 1.1 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, filter: 'blur(20px)', scale: 1.2 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="text-center px-12 relative z-10 flex flex-col items-center">
        <motion.div 
          className="overflow-hidden mb-6"
        >
          <motion.h2 
            className="text-[2vw] font-body font-bold text-[#46d7ff] uppercase tracking-[0.5em]"
            initial={{ y: "100%", opacity: 0 }}
            animate={phase >= 1 ? { y: 0, opacity: 1 } : { y: "100%", opacity: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          >
            A Lone Guardian
          </motion.h2>
        </motion.div>
        
        <motion.h1 
          className="text-[8vw] font-display font-black tracking-tighter text-white leading-none uppercase drop-shadow-[0_0_30px_rgba(70,215,255,0.4)]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {'SURVIVE'.split('').map((char, i) => (
            <motion.span key={i} style={{ display: 'inline-block' }}
              initial={{ opacity: 0, y: 100, rotateX: 90 }}
              animate={phase >= 2 ? { opacity: 1, y: 0, rotateX: 0 } : { opacity: 0, y: 100, rotateX: 90 }}
              transition={{ type: 'spring', stiffness: 200, damping: 20, delay: phase >= 2 ? i * 0.05 : 0 }}>
              {char}
            </motion.span>
          ))}
        </motion.h1>

        <motion.p 
          className="text-[2.5vw] text-white/80 mt-8 font-body font-medium"
          initial={{ opacity: 0, filter: 'blur(10px)', y: 20 }}
          animate={phase >= 3 ? { opacity: 1, filter: 'blur(0px)', y: 0 } : { opacity: 0, filter: 'blur(10px)', y: 20 }}
          transition={{ duration: 0.8 }}>
          The Temple Arena Awaits
        </motion.p>
      </div>

      {/* Decorative corners */}
      {phase >= 1 && (
        <>
          <motion.div className="absolute top-[10%] left-[5%] w-16 h-16 border-t-2 border-l-2 border-[#46d7ff]/50" 
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1 }} />
          <motion.div className="absolute bottom-[10%] right-[5%] w-16 h-16 border-b-2 border-r-2 border-[#46d7ff]/50"
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1 }} />
        </>
      )}
    </motion.div>
  );
}