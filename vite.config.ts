import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	preview: {
		// Any ngrok tunnel may front the preview for phone testing.
		allowedHosts: ['.ngrok-free.app']
	}
});
