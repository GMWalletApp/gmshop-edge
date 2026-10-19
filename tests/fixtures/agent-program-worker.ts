import { z } from "zod";
import { requestProgram } from "../../src/features/agent-program/server/client";

export default {
	async fetch(_request: Request, env: { PROGRAM_TOKEN: string }) {
		try {
			const data = await requestProgram(
				env.PROGRAM_TOKEN,
				"rules",
				z.object({ enabled: z.boolean() }),
			);
			return Response.json({ ok: true, data });
		} catch (error) {
			return Response.json({
				ok: false,
				code:
					error && typeof error === "object" && "code" in error
						? error.code
						: "unknown",
			});
		}
	},
};
