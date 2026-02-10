import { ProjectCard } from './ProjectCard'
import styles from './ProjectGrid.module.css'
import projects from '../../data/projects.json'

interface ProjectGridProps {
  featured?: boolean
}

export function ProjectGrid({ featured = false }: ProjectGridProps) {
  const filteredProjects = featured
    ? projects.filter((p) => p.featured)
    : projects

  return (
    <div className={styles.grid}>
      {filteredProjects.map((project, index) => (
        <ProjectCard key={project.id} {...project} index={index} />
      ))}
    </div>
  )
}
