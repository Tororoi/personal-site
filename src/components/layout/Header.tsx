import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import styles from './Header.module.css';
import { useState, useEffect } from 'react';

export function Header() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <motion.header
      className={`${styles.header} ${scrolled ? styles.scrolled : ''}`}
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <div className="container">
        <nav className={styles.nav}>
          <Link to="/" className={styles.logo}>
            <span className="text-gradient">TC</span>
          </Link>

          <ul className={styles.navList}>
            <li>
              <Link to="/" className={styles.navLink}>
                Home
              </Link>
            </li>
            <li>
              <Link to="/projects" className={styles.navLink}>
                Projects
              </Link>
            </li>
            <li>
              <Link to="/blog" className={styles.navLink}>
                Blog
              </Link>
            </li>
            <li>
              <Link to="/about" className={styles.navLink}>
                About
              </Link>
            </li>
            <li>
              <Link to="/contact" className={styles.navLink}>
                Contact
              </Link>
            </li>
          </ul>

          <a
            href="/Resume.pdf"
            className={styles.resumeBtn}
            target="_blank"
            rel="noopener noreferrer"
          >
            Resume
          </a>
        </nav>
      </div>
    </motion.header>
  );
}
