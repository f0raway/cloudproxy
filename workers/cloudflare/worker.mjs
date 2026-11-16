import { connect } from 'cloudflare:sockets';
import { makeWorker } from './bridge.mjs';
export default makeWorker(connect);
