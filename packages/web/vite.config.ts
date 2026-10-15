import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const host = "http://127.0.0.1:3000";

export default defineConfig({
	plugins: [preact()],
	server: {
		proxy: {
			"/api": host,
			"/healthz": host,
		},
	},
});
