import { eveChannel } from 'eve/channels/eve';
import { httpBasic, localDev } from 'eve/channels/auth';

// The eve server only listens on loopback inside the service. The worker and the public API call it with this shared password.
const password = process.env.EVE_INTERNAL_PASSWORD ?? '';
export default eveChannel({ auth: [...(password.length >= 16 ? [httpBasic({ username: 'worker', password })] : []), localDev()] });
