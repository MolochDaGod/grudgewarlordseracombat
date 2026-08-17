import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';

export function Scene3() {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 200),
      setTimeout(() => setPhase(2), 800),
      setTimeout(() => setPhase(3), 1500),
      setTimeout(() => setPhase(4), 2200),
      setTimeout(() => setPhase(5), 3500),
    ];
    return () => timers.forEach(t => clearTimeout(t));
  }, []);

  return (
    <motion.div 
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      initial={{ opacity: 0, scale: 1.2, filter: 'blur(10px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, y: -100 }}
      transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Background action shot */}
      <motion.div 
        className="absolute inset-0 z-0 opacity-40 mix-blend-screen"
        initial={{ scale: 1.1 }}
        animate={{ scale: 1.0 }}
        transition={{ duration: 4, ease: "linear" }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/skill-effect.png`} 
          alt="Combat VFX" 
          className="w-full h-full object-cover"
        />
      </motion.div>

      {/* Foreground Weapon */}
      <motion.div 
        className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none"
        initial={{ y: 200, opacity: 0, rotate: -20 }}
        animate={phase >= 2 ? { y: 0, opacity: 0.8, rotate: 10 } : { y: 200, opacity: 0, rotate: -20 }}
        transition={{ type: "spring", stiffness: 80, damping: 15 }}
      >
        <img 
          src={`${import.meta.env.BASE_URL}images/saber-weapon.png`} 
          alt="Glowing Weapon" 
          className="w-[80vw] h-auto max-h-[120vh] object-contain object-center drop-shadow-[0_0_50px_rgba(70,215,255,0.8)]"
        />
      </motion.div>

      <div className="z-20 text-center relative w-full h-full flex flex-col justify-center">
        <motion.h2 
          className="text-[6vw] font-display font-black uppercase text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.8)]"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={phase >= 1 ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
          transition={{ type: "spring", stiffness: 200, damping: 20 }}
        >
          Unleash Your <span className="text-[#46d7ff]">Force</span>
        </motion.h2>

        <div className="flex justify-center gap-12 mt-12">
          {/* Skill 1 */}
          <motion.div 
            className="flex flex-col items-center"
            initial={{ opacity: 0, y: 50 }}
            animate={phase >= 3 ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
            transition={{ type: "spring", stiffness: 100, damping: 15 }}
          >
            <div className="w-20 h-20 rounded-full border-[3px] border-[#46d7ff] flex items-center justify-center bg-black/50 backdrop-blur-md mb-4 shadow-[0_0_20px_rgba(70,215,255,0.4)]">
              <span className="text-3xl font-display text-white">Q</span>
            </div>
            <span className="text-xl font-body font-bold text-white uppercase tracking-widest">Signature</span>
          </motion.div>

          {/* Skill 2 */}
          <motion.div 
            className="flex flex-col items-center"
            initial={{ opacity: 0, y: 50 }}
            animate={phase >= 4 ? { opacity: 1, y: 0 } : { opacity: 0, y: 50 }}
            transition={{ type: "spring", stiffness: 100, damping: 15 }}
          >
            <div className="w-20 h-20 rounded-full border-[3px] border-purple-500 flex items-center justify-center bg-black/50 backdrop-blur-md mb-4 shadow-[0_0_20px_rgba(168,85,247,0.4)]">
              <span className="text-3xl font-display text-white">E</span>
            </div>
            <span className="text-xl font-body font-bold text-white uppercase tracking-widest">Ultimate</span>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}