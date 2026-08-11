export type Job = {
	name: string;
	years: string;
	stack: string;
	bullets: string[];
};

export const sections = [
	{ id: 'rs-about', label: 'ABOUT' },
	{ id: 'rs-experience', label: 'EXPERIENCE' },
	{ id: 'rs-side-projects', label: 'SIDE PROJECTS' },
	{ id: 'rs-education', label: 'EDUCATION' },
	{ id: 'rs-frameworks', label: 'FRAMEWORKS & TOOLS' },
	{ id: 'rs-languages', label: 'LANGUAGES' }
];

export const page1Jobs: Job[] = [
	{
		name: 'Attunement (YC S24), AI Psychology Platform',
		years: '2024 – 2025',
		stack: 'React | Next.js | Python | PostgreSQL | Supabase',
		bullets: [
			'Built full-stack features for a HIPAA-compliant AI platform, including document ingestion pipelines, psychological report analysis (WISC, WAIS), and interactive chat interfaces',
			'Shipped MFA and HIPAA-compliant intake forms and patient flows',
			'Designed a custom HIPAA compliant audit system in Supabase covering the entire platform',
			'Embedded with the founding team on roadmap and release planning across the engagement'
		]
	},
	{
		name: 'Lux Capital',
		years: '2022 – Present',
		stack: 'Vue 3 | NestJS | PostgreSQL | TypeORM | Auth0 | Redis | GCP',
		bullets: [
			'Led cross-team Heroku-to-GCP migration and currently maintain production GCP infrastructure',
			'Upgraded LP-facing annual keynote from React to Next.js and internal VC dashboard from Vue 2 to 3',
			'Rebuilt the admin panel login system with a multi-layered Auth0 integration',
			'Integrated Attio CRM to sync across 450+ portfolio companies, with automatic retries and rate-limiting',
			'Partnered with finance team on data integrity tooling (date-range diff feature) and cut main endpoint latency from 30s to 1s; reduced daily sync job runtime by 97%'
		]
	},
	{
		name: 'Warner Brothers, Beetlejuice Beetlejuice',
		years: '2024',
		stack: 'React | Node.js',
		bullets: [
			'Built CMS and roles system for activations and gallery backend with i18n support across 40+ global markets'
		]
	},
	{
		name: 'Tiny Goliath, Amazon Fulfillment App',
		years: '2023 – 2024',
		stack: 'Ruby on Rails | React | PostgreSQL',
		bullets: [
			'Led backend development from inception to launch while working closely with the frontend developer',
			"Integrated Shopify and Amazon's Selling Partner APIs, and securely managed customer data using AWS IAM",
			'Developed sync protocols to manage data flow and data consistency in distributed environments'
		]
	},
	{
		name: 'US Marines, Station Select & Activation Tools',
		years: '2023 – 2024',
		stack: 'Electron | Node.js | React | LokiJS',
		bullets: [
			'Designed new database schema to support new functionality while still supporting legacy data for viewing and uploading',
			'Facilitated the launch of more customizable options and expanded field kit availability'
		]
	}
];

export const page2Jobs: Job[] = [
	{
		name: 'CollegeAidPro, MyCAP',
		years: '2021 – 2023',
		stack: 'Next.js | React | PHP Laravel | MySQL | HTML | CSS',
		bullets: [
			'Developed D2C MyCAP student portal including user dashboards, search/filtering, payment integrations, scholarship matching, and user management',
			'Planned and scoped full v2 build and timeline of MyCAP D2C platform while also client-facing',
			'Collaborated with another vendor to integrate a custom API, co-design new features, and optimize shared database table structures',
			'Implemented whitelabeling architecture for MyCAP partners including theming, Auth0 authentication, and SSO tokens',
			'Designed intricate user interfaces optimizing user experience for complex forms'
		]
	},
	{
		name: 'Better Brand',
		years: '2021',
		stack: 'Next.js | Node.js | PostgreSQL',
		bullets: [
			'Built full-stack headless e-commerce platform with product catalog, checkout flows, subscriptions, and Stripe payment integrations'
		]
	}
];
