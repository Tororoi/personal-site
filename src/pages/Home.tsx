import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import { ProjectGrid } from '../components/portfolio/ProjectGrid';
import styles from './Home.module.css';

export function Home() {
  return (
    <main className={styles.home}>
      {/* Hero Section */}
      <section className={styles.hero}>
        <div className="container">
          <motion.div
            className={styles.heroContent}
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <motion.p
              className={styles.greeting}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              Hello, I'm
            </motion.p>
            <motion.h1
              className={styles.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.8 }}
            >
              Thomas Cantwell
            </motion.h1>
            <motion.p
              className={styles.tagline}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5, duration: 0.8 }}
            >
              Full-Stack Developer & Creative Technologist
            </motion.p>
            <motion.p
              className={styles.description}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.8 }}
            >
              I build interactive web experiences and creative tools with modern
              technologies. Specializing in React, TypeScript, and innovative UI
              design.
            </motion.p>
            <motion.div
              className={styles.cta}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.9, duration: 0.8 }}
            >
              <Link to="/projects" className={styles.primaryBtn}>
                View My Work
              </Link>
              <Link to="/contact" className={styles.secondaryBtn}>
                Get In Touch
              </Link>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Featured Projects Section */}
      <section className={styles.featuredProjects}>
        <div className="container">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <h2 className={styles.sectionTitle}>Featured Projects</h2>
            <p className={styles.sectionDescription}>
              A selection of my recent work in web development and creative
              coding.
            </p>
          </motion.div>
          <ProjectGrid featured={true} />
          <motion.div
            className={styles.viewAll}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.3, duration: 0.6 }}
          >
            <Link to="/projects" className={styles.viewAllBtn}>
              View All Projects →
            </Link>
          </motion.div>
        </div>
      </section>
    </main>
  );
}
