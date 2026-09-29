import { runWithRuntimeEnv } from "#/server/runtime/context";
import { createNodeApplication } from "#/server/runtime/node/application";
import { handleAppRequest } from "#/server-entry";

const application = await createNodeApplication();

export default {
	fetch(request: Request) {
		return runWithRuntimeEnv(application.env, () =>
			handleAppRequest(request, application.env),
		);
	},
};
