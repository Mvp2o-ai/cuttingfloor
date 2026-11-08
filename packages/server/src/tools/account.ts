import { AccountGetInput, AccountGetResult } from '@cuttingfloor/schema';
import type { McpServer } from '@modelcontextprotocol/server';
import { guard, ok } from '../result.ts';
import type { ServerDeps } from '../server.ts';

// account.get: the signed-in account's plan and credits. Hosted, the deployment answers it
// (deps.account); a server you run yourself has no plan or credits.

const LOCAL: AccountGetResult = {
  plan: 'local',
  plan_name: 'Your own server',
  credits: { left: null, used: 0, free: 0, bought: 0, per_month: null, renews: null },
  warnings: [],
  top_up: null,
  packs: [],
  limits: { jobs: null, export_short_side: null, judgments_per_day: null, storage_gb: null },
  account_url: null,
};

export function registerAccountTools(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'account.get',
    {
      title: 'Get account',
      description:
        "The signed-in account's plan and credits: credits left and used, free and bought, the emails sent as they run low, automatic top-up, the packs on sale, the plan's limits, and the account page where the user tops up. A credit is one minute of a job running (export, import, analysis, create.*); editing and previews are free. At 0 credits new jobs won't start until the user tops up on the account page.",
      inputSchema: AccountGetInput,
      outputSchema: AccountGetResult,
      annotations: {
        title: 'Get account',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(async () => ok(deps.account ? await deps.account() : LOCAL)),
  );
}
