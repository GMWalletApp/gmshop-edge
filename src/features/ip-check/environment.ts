// Browser environment fingerprint. Computed and shown in this page only:
// never sent to our server, stored, or used to recognise returning visitors.

export type Environment = {
	canvasHash: string | null;
	webglHash: string | null;
	gpuVendor: string | null;
	gpuRenderer: string | null;
	os: string;
	platform: string | null;
	browser: string;
	screen: string;
	cores: number | null;
	memory: number | null;
	touchPoints: number;
	languages: string[];
	timezone: string | null;
	webdriver: boolean;
	userAgent: string;
};

// 32-bit FNV-1a: short, stable display code, not a security hash.
export function fnv1a(value: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function osFromUserAgent(ua: string) {
	if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
	if (/android/i.test(ua)) return "Android";
	if (/windows/i.test(ua)) return "Windows";
	if (/mac os x|macintosh/i.test(ua)) return "macOS";
	if (/cros/i.test(ua)) return "ChromeOS";
	if (/linux/i.test(ua)) return "Linux";
	return "Unknown";
}

export function browserFromUserAgent(ua: string) {
	const match =
		ua.match(/(Edg|OPR|Firefox|CriOS|FxiOS)\/([\d.]+)/) ??
		ua.match(/(Chrome)\/([\d.]+)/) ??
		ua.match(/Version\/([\d.]+).*(Safari)/);
	if (!match) return "Unknown";
	if (match[2] === "Safari") return `Safari ${match[1]}`;
	const names: Record<string, string> = {
		Edg: "Edge",
		OPR: "Opera",
		CriOS: "Chrome",
		FxiOS: "Firefox",
	};
	return `${names[match[1] ?? ""] ?? match[1]} ${match[2]}`;
}

function canvasHash() {
	try {
		const canvas = document.createElement("canvas");
		canvas.width = 240;
		canvas.height = 60;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.textBaseline = "top";
		ctx.font = "16px Arial";
		ctx.fillStyle = "#f60";
		ctx.fillRect(100, 1, 62, 20);
		ctx.fillStyle = "#069";
		ctx.fillText("laoshirenvip ip-check 😃", 2, 15);
		ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
		ctx.beginPath();
		ctx.arc(50, 40, 18, 0, Math.PI * 2);
		ctx.fill();
		const data = canvas.toDataURL();
		return data.length > 32 ? fnv1a(data) : null;
	} catch {
		return null;
	}
}

function webgl() {
	try {
		const canvas = document.createElement("canvas");
		const gl = (canvas.getContext("webgl") ??
			canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
		if (!gl) return { hash: null, vendor: null, renderer: null };
		const debug = gl.getExtension("WEBGL_debug_renderer_info");
		const vendor = String(
			debug
				? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
				: gl.getParameter(gl.VENDOR),
		);
		const renderer = String(
			debug
				? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
				: gl.getParameter(gl.RENDERER),
		);
		const parts = [
			vendor,
			renderer,
			gl.getParameter(gl.VERSION),
			gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
			gl.getParameter(gl.MAX_TEXTURE_SIZE),
			gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
			(gl.getSupportedExtensions() ?? []).join(","),
		];
		return { hash: fnv1a(parts.join("|")), vendor, renderer };
	} catch {
		return { hash: null, vendor: null, renderer: null };
	}
}

export function collectEnvironment(): Environment {
	const ua = navigator.userAgent;
	const gl = webgl();
	const dpr = window.devicePixelRatio || 1;
	return {
		canvasHash: canvasHash(),
		webglHash: gl.hash,
		gpuVendor: gl.vendor,
		gpuRenderer: gl.renderer,
		os: osFromUserAgent(ua),
		platform: navigator.platform || null,
		browser: browserFromUserAgent(ua),
		screen: `${screen.width}×${screen.height} @${Math.round(dpr * 100) / 100}x`,
		cores: navigator.hardwareConcurrency || null,
		memory:
			(navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
		touchPoints: navigator.maxTouchPoints || 0,
		languages: [...(navigator.languages ?? [navigator.language])].filter(
			Boolean,
		),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
		webdriver: navigator.webdriver === true,
		userAgent: ua,
	};
}

export type EnvironmentFinding = "automation" | "virtual" | "mismatch";

const virtualGpu =
	/swiftshader|llvmpipe|softpipe|vmware|virtualbox|microsoft basic render|parallels|virgl|mesa offscreen/i;

export function assessEnvironment(env: Environment): EnvironmentFinding[] {
	const findings: EnvironmentFinding[] = [];
	if (env.webdriver || /headless/i.test(env.userAgent))
		findings.push("automation");
	if (env.gpuRenderer && virtualGpu.test(env.gpuRenderer))
		findings.push("virtual");
	const platform = env.platform ?? "";
	const gpu = env.gpuRenderer ?? "";
	const mismatch =
		(env.os === "Windows" &&
			(/^mac|iphone|ipad|linux/i.test(platform) || /apple/i.test(gpu))) ||
		(env.os === "macOS" &&
			(/^win|linux/i.test(platform) || /direct3d|d3d1[01]/i.test(gpu))) ||
		((env.os === "iOS" || env.os === "Android") && env.touchPoints === 0) ||
		(env.os === "Linux" && /^(win|mac)/i.test(platform));
	if (mismatch) findings.push("mismatch");
	return findings;
}
