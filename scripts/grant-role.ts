// Grants or takes away a cuttingfloor role in the rights table (apps/hosted/src/rights.ts), on
// the server, inside the running container:
//
//   docker compose exec cuttingfloor node scripts/grant-role.ts grant <user_id> admin "<reason>"
//   docker compose exec cuttingfloor node scripts/grant-role.ts revoke <user_id> admin
//   docker compose exec cuttingfloor node scripts/grant-role.ts show <user_id>
//
// The user id is the WorkOS one (user_…). The data root is CUTTINGFLOOR_DATA (/data in the image).

import { userInfo } from 'node:os';
import { Rights, ROLES, type Role } from '../apps/hosted/src/rights.ts';
import { Workspace } from '../packages/core/src/index.ts';

const [action, user = '', role = 'admin', reason = ''] = process.argv.slice(2);
const rights = new Rights(new Workspace(process.env.CUTTINGFLOOR_DATA ?? '/data'));
if (!ROLES.includes(role as Role)) {
  process.stderr.write(`role must be one of: ${ROLES.join(', ')}\n`);
  process.exit(1);
}
if (action === 'grant') {
  if (!reason) {
    process.stderr.write('say why: grant <user_id> <role> "<reason>"\n');
    process.exit(1);
  }
  const file = await rights.grant(user, role as Role, `script:${userInfo().username}`, reason);
  process.stdout.write(`${JSON.stringify(file, null, 2)}\n`);
} else if (action === 'revoke') {
  process.stdout.write(
    `${(await rights.revoke(user, role as Role)) ? 'revoked' : 'had no such role'}\n`,
  );
} else if (action === 'show') {
  process.stdout.write(`${JSON.stringify(await rights.roles(user))}\n`);
} else {
  process.stderr.write('usage: grant-role.ts grant|revoke|show <user_id> [role] [reason]\n');
  process.exit(1);
}
