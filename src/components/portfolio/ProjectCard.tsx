import { motion } from 'motion/react';
import styles from './ProjectCard.module.css';
import { FaGithub, FaExternalLinkAlt } from 'react-icons/fa';

interface ProjectCardProps {
  id: string;
  title: string;
  description: string;
  technologies: string[];
  image: string;
  liveUrl: string;
  githubUrl: string;
  featured?: boolean;
  index?: number;
}

export function ProjectCard({
  title,
  description,
  technologies,
  image,
  liveUrl,
  githubUrl,
  index = 0,
}: ProjectCardProps) {
  return (
    <motion.article
      className={styles.card}
      initial={{ opacity: 0, y: 50 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-100px' }}
      transition={{ delay: index * 0.1, duration: 0.5 }}
      whileHover={{ y: -8 }}
    >
      <a
        href={liveUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.imageLink}
      >
        <div className={styles.imageContainer}>
          <img src={image} alt={title} className={styles.image} />
          <div className={styles.overlay}>
            <FaExternalLinkAlt className={styles.overlayIcon} />
          </div>
        </div>
      </a>

      <div className={styles.content}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.description}>{description}</p>

        <div className={styles.technologies}>
          {technologies.map((tech) => (
            <span key={tech} className={styles.tech}>
              {tech}
            </span>
          ))}
        </div>

        <div className={styles.links}>
          <motion.a
            href={githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <FaGithub />
            <span>Code</span>
          </motion.a>
          <motion.a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <FaExternalLinkAlt />
            <span>Live Demo</span>
          </motion.a>
        </div>
      </div>
    </motion.article>
  );
}
