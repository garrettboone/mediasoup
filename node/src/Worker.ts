import * as process from 'node:process';
import * as path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { version } from './';
import { Logger } from './Logger';
import { EnhancedEventEmitter } from './EnhancedEventEmitter';
import * as ortc from './ortc';
import { Channel } from './Channel';
import { Router, RouterOptions, socketFlagsToFbs } from './Router';
import { WebRtcServer, WebRtcServerOptions } from './WebRtcServer';
import { RtpCodecCapability } from './RtpParameters';
import { AppData } from './types';
import * as utils from './utils';
import { Event } from './fbs/notification';
import * as FbsRequest from './fbs/request';
import * as FbsWorker from './fbs/worker';
import * as FbsTransport from './fbs/transport';
import { Protocol as FbsTransportProtocol } from './fbs/transport/protocol';

export type WorkerLogLevel = 'debug' | 'warn' | 'error' | 'none';

export type WorkerLogTag =
	| 'info'
	| 'ice'
	| 'dtls'
	| 'rtp'
	| 'srtp'
	| 'rtcp'
	| 'rtx'
	| 'bwe'
	| 'score'
	| 'simulcast'
	| 'svc'
	| 'sctp'
	| 'message';

export type WorkerSettings<WorkerAppData extends AppData = AppData> = {
	/**
	 * Logging level for logs generated by the media worker subprocesses (check
	 * the Debugging documentation). Valid values are 'debug', 'warn', 'error' and
	 * 'none'. Default 'error'.
	 */
	logLevel?: WorkerLogLevel;

	/**
	 * Log tags for debugging. Check the meaning of each available tag in the
	 * Debugging documentation.
	 */
	logTags?: WorkerLogTag[];

	/**
	 * Minimun RTC port for ICE, DTLS, RTP, etc. Default 10000.
	 */
	rtcMinPort?: number;

	/**
	 * Maximum RTC port for ICE, DTLS, RTP, etc. Default 59999.
	 */
	rtcMaxPort?: number;

	/**
	 * Path to the DTLS public certificate file in PEM format. If unset, a
	 * certificate is dynamically created.
	 */
	dtlsCertificateFile?: string;

	/**
	 * Path to the DTLS certificate private key file in PEM format. If unset, a
	 * certificate is dynamically created.
	 */
	dtlsPrivateKeyFile?: string;

	/**
	 * Field trials for libwebrtc.
	 * @private
	 *
	 * NOTE: For advanced users only. An invalid value will make the worker crash.
	 * Default value is
	 * "WebRTC-Bwe-AlrLimitedBackoff/Enabled/".
	 */
	libwebrtcFieldTrials?: string;

	/**
	 * Custom application data.
	 */
	appData?: WorkerAppData;
};

export type WorkerUpdateableSettings<T extends AppData = AppData> = Pick<
	WorkerSettings<T>,
	'logLevel' | 'logTags'
>;

/**
 * An object with the fields of the uv_rusage_t struct.
 *
 * - http://docs.libuv.org/en/v1.x/misc.html#c.uv_rusage_t
 * - https://linux.die.net/man/2/getrusage
 */
export type WorkerResourceUsage = {
	/* eslint-disable camelcase */

	/**
	 * User CPU time used (in ms).
	 */
	ru_utime: number;

	/**
	 * System CPU time used (in ms).
	 */
	ru_stime: number;

	/**
	 * Maximum resident set size.
	 */
	ru_maxrss: number;

	/**
	 * Integral shared memory size.
	 */
	ru_ixrss: number;

	/**
	 * Integral unshared data size.
	 */
	ru_idrss: number;

	/**
	 * Integral unshared stack size.
	 */
	ru_isrss: number;

	/**
	 * Page reclaims (soft page faults).
	 */
	ru_minflt: number;

	/**
	 * Page faults (hard page faults).
	 */
	ru_majflt: number;

	/**
	 * Swaps.
	 */
	ru_nswap: number;

	/**
	 * Block input operations.
	 */
	ru_inblock: number;

	/**
	 * Block output operations.
	 */
	ru_oublock: number;

	/**
	 * IPC messages sent.
	 */
	ru_msgsnd: number;

	/**
	 * IPC messages received.
	 */
	ru_msgrcv: number;

	/**
	 * Signals received.
	 */
	ru_nsignals: number;

	/**
	 * Voluntary context switches.
	 */
	ru_nvcsw: number;

	/**
	 * Involuntary context switches.
	 */
	ru_nivcsw: number;

	/* eslint-enable camelcase */
};

export type WorkerDump = {
	pid: number;
	webRtcServerIds: string[];
	routerIds: string[];
	channelMessageHandlers: {
		channelRequestHandlers: string[];
		channelNotificationHandlers: string[];
	};
	liburing?: {
		sqeProcessCount: number;
		sqeMissCount: number;
		userDataMissCount: number;
	};
};

export type WorkerEvents = {
	died: [Error];
	listenererror: [string, Error];
	// Private events.
	'@success': [];
	'@failure': [Error];
};

export type WorkerObserverEvents = {
	close: [];
	newwebrtcserver: [WebRtcServer];
	newrouter: [Router];
};

// If env MEDIASOUP_WORKER_BIN is given, use it as worker binary.
// Otherwise if env MEDIASOUP_BUILDTYPE is 'Debug' use the Debug binary.
// Otherwise use the Release binary.
export const workerBin = process.env.MEDIASOUP_WORKER_BIN
	? process.env.MEDIASOUP_WORKER_BIN
	: process.env.MEDIASOUP_BUILDTYPE === 'Debug'
		? path.join(
				__dirname,
				'..',
				'..',
				'worker',
				'out',
				'Debug',
				'mediasoup-worker',
			)
		: path.join(
				__dirname,
				'..',
				'..',
				'worker',
				'out',
				'Release',
				'mediasoup-worker',
			);

const logger = new Logger('Worker');
const workerLogger = new Logger('Worker');

export class Worker<
	WorkerAppData extends AppData = AppData,
> extends EnhancedEventEmitter<WorkerEvents> {
	// mediasoup-worker child process.
	#child?: ChildProcess;

	// Worker process PID.
	readonly #pid: number;

	// Channel instance.
	readonly #channel: Channel;

	// Closed flag.
	#closed = false;

	// Died dlag.
	#died = false;

	// Custom app data.
	#appData: WorkerAppData;

	// WebRtcServers set.
	readonly #webRtcServers: Set<WebRtcServer> = new Set();

	// Routers set.
	readonly #routers: Set<Router> = new Set();

	// Observer instance.
	readonly #observer = new EnhancedEventEmitter<WorkerObserverEvents>();

	/**
	 * @private
	 */
	constructor({
		logLevel,
		logTags,
		rtcMinPort,
		rtcMaxPort,
		dtlsCertificateFile,
		dtlsPrivateKeyFile,
		libwebrtcFieldTrials,
		appData,
	}: WorkerSettings<WorkerAppData>) {
		super();

		logger.debug('constructor()');

		let spawnBin = workerBin;
		let spawnArgs: string[] = [];

		if (process.env.MEDIASOUP_USE_VALGRIND === 'true') {
			spawnBin = process.env.MEDIASOUP_VALGRIND_BIN || 'valgrind';

			if (process.env.MEDIASOUP_VALGRIND_OPTIONS) {
				spawnArgs = spawnArgs.concat(
					process.env.MEDIASOUP_VALGRIND_OPTIONS.split(/\s+/),
				);
			}

			spawnArgs.push(workerBin);
		}

		if (typeof logLevel === 'string' && logLevel) {
			spawnArgs.push(`--logLevel=${logLevel}`);
		}

		for (const logTag of Array.isArray(logTags) ? logTags : []) {
			if (typeof logTag === 'string' && logTag) {
				spawnArgs.push(`--logTag=${logTag}`);
			}
		}

		if (typeof rtcMinPort === 'number' && !Number.isNaN(rtcMinPort)) {
			spawnArgs.push(`--rtcMinPort=${rtcMinPort}`);
		}

		if (typeof rtcMaxPort === 'number' && !Number.isNaN(rtcMaxPort)) {
			spawnArgs.push(`--rtcMaxPort=${rtcMaxPort}`);
		}

		if (typeof dtlsCertificateFile === 'string' && dtlsCertificateFile) {
			spawnArgs.push(`--dtlsCertificateFile=${dtlsCertificateFile}`);
		}

		if (typeof dtlsPrivateKeyFile === 'string' && dtlsPrivateKeyFile) {
			spawnArgs.push(`--dtlsPrivateKeyFile=${dtlsPrivateKeyFile}`);
		}

		if (typeof libwebrtcFieldTrials === 'string' && libwebrtcFieldTrials) {
			spawnArgs.push(`--libwebrtcFieldTrials=${libwebrtcFieldTrials}`);
		}

		logger.debug(
			'spawning worker process: %s %s',
			spawnBin,
			spawnArgs.join(' '),
		);

		this.#child = spawn(
			// command
			spawnBin,
			// args
			spawnArgs,
			// options
			{
				env: {
					MEDIASOUP_VERSION: version,
					// Let the worker process inherit all environment variables, useful
					// if a custom and not in the path GCC is used so the user can set
					// LD_LIBRARY_PATH environment variable for runtime.
					...process.env,
				},

				detached: false,

				// fd 0 (stdin)   : Just ignore it.
				// fd 1 (stdout)  : Pipe it for 3rd libraries that log their own stuff.
				// fd 2 (stderr)  : Same as stdout.
				// fd 3 (channel) : Producer Channel fd.
				// fd 4 (channel) : Consumer Channel fd.
				stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
				windowsHide: true,
			},
		);

		this.#pid = this.#child.pid!;

		this.#channel = new Channel({
			producerSocket: this.#child.stdio[3],
			consumerSocket: this.#child.stdio[4],
			pid: this.#pid,
		});

		this.#appData = appData || ({} as WorkerAppData);

		let spawnDone = false;

		// Listen for 'running' notification.
		this.#channel.once(String(this.#pid), (event: Event) => {
			if (!spawnDone && event === Event.WORKER_RUNNING) {
				spawnDone = true;

				logger.debug('worker process running [pid:%s]', this.#pid);

				this.emit('@success');
			}
		});

		this.#child.on('exit', (code, signal) => {
			this.#child = undefined;

			if (!spawnDone) {
				spawnDone = true;

				if (code === 42) {
					logger.error(
						'worker process failed due to wrong settings [pid:%s]',
						this.#pid,
					);

					this.close();
					this.emit('@failure', new TypeError('wrong settings'));
				} else {
					logger.error(
						'worker process failed unexpectedly [pid:%s, code:%s, signal:%s]',
						this.#pid,
						code,
						signal,
					);

					this.close();
					this.emit(
						'@failure',
						new Error(`[pid:${this.#pid}, code:${code}, signal:${signal}]`),
					);
				}
			} else {
				logger.error(
					'worker process died unexpectedly [pid:%s, code:%s, signal:%s]',
					this.#pid,
					code,
					signal,
				);

				this.workerDied(
					new Error(`[pid:${this.#pid}, code:${code}, signal:${signal}]`),
				);
			}
		});

		this.#child.on('error', error => {
			this.#child = undefined;

			if (!spawnDone) {
				spawnDone = true;

				logger.error(
					'worker process failed [pid:%s]: %s',
					this.#pid,
					error.message,
				);

				this.close();
				this.emit('@failure', error);
			} else {
				logger.error(
					'worker process error [pid:%s]: %s',
					this.#pid,
					error.message,
				);

				this.workerDied(error);
			}
		});

		// Be ready for 3rd party worker libraries logging to stdout.
		this.#child.stdout!.on('data', buffer => {
			for (const line of buffer.toString('utf8').split('\n')) {
				if (line) {
					workerLogger.debug(`(stdout) ${line}`);
				}
			}
		});

		// In case of a worker bug, mediasoup will log to stderr.
		this.#child.stderr!.on('data', buffer => {
			for (const line of buffer.toString('utf8').split('\n')) {
				if (line) {
					workerLogger.error(`(stderr) ${line}`);
				}
			}
		});
	}

	/**
	 * Worker process identifier (PID).
	 */
	get pid(): number {
		return this.#pid;
	}

	/**
	 * Whether the Worker is closed.
	 */
	get closed(): boolean {
		return this.#closed;
	}

	/**
	 * Whether the Worker died.
	 */
	get died(): boolean {
		return this.#died;
	}

	/**
	 * App custom data.
	 */
	get appData(): WorkerAppData {
		return this.#appData;
	}

	/**
	 * App custom data setter.
	 */
	set appData(appData: WorkerAppData) {
		this.#appData = appData;
	}

	/**
	 * Observer.
	 */
	get observer(): EnhancedEventEmitter<WorkerObserverEvents> {
		return this.#observer;
	}

	/**
	 * @private
	 * Just for testing purposes.
	 */
	get webRtcServersForTesting(): Set<WebRtcServer> {
		return this.#webRtcServers;
	}

	/**
	 * @private
	 * Just for testing purposes.
	 */
	get routersForTesting(): Set<Router> {
		return this.#routers;
	}

	/**
	 * Close the Worker.
	 */
	close(): void {
		if (this.#closed) {
			return;
		}

		logger.debug('close()');

		this.#closed = true;

		// Kill the worker process.
		if (this.#child) {
			// Remove event listeners but leave a fake 'error' hander to avoid
			// propagation.
			this.#child.removeAllListeners('exit');
			this.#child.removeAllListeners('error');
			this.#child.on('error', () => {});
			this.#child.kill('SIGTERM');
			this.#child = undefined;
		}

		// Close the Channel instance.
		this.#channel.close();

		// Close every Router.
		for (const router of this.#routers) {
			router.workerClosed();
		}
		this.#routers.clear();

		// Close every WebRtcServer.
		for (const webRtcServer of this.#webRtcServers) {
			webRtcServer.workerClosed();
		}
		this.#webRtcServers.clear();

		// Emit observer event.
		this.#observer.safeEmit('close');
	}

	/**
	 * Dump Worker.
	 */
	async dump(): Promise<WorkerDump> {
		logger.debug('dump()');

		// Send the request and wait for the response.
		const response = await this.#channel.request(FbsRequest.Method.WORKER_DUMP);

		/* Decode Response. */
		const dump = new FbsWorker.DumpResponse();

		response.body(dump);

		return parseWorkerDumpResponse(dump);
	}

	/**
	 * Get mediasoup-worker process resource usage.
	 */
	async getResourceUsage(): Promise<WorkerResourceUsage> {
		logger.debug('getResourceUsage()');

		const response = await this.#channel.request(
			FbsRequest.Method.WORKER_GET_RESOURCE_USAGE,
		);

		/* Decode Response. */
		const resourceUsage = new FbsWorker.ResourceUsageResponse();

		response.body(resourceUsage);

		const ru = resourceUsage.unpack();

		/* eslint-disable camelcase */
		return {
			ru_utime: Number(ru.ruUtime),
			ru_stime: Number(ru.ruStime),
			ru_maxrss: Number(ru.ruMaxrss),
			ru_ixrss: Number(ru.ruIxrss),
			ru_idrss: Number(ru.ruIdrss),
			ru_isrss: Number(ru.ruIsrss),
			ru_minflt: Number(ru.ruMinflt),
			ru_majflt: Number(ru.ruMajflt),
			ru_nswap: Number(ru.ruNswap),
			ru_inblock: Number(ru.ruInblock),
			ru_oublock: Number(ru.ruOublock),
			ru_msgsnd: Number(ru.ruMsgsnd),
			ru_msgrcv: Number(ru.ruMsgrcv),
			ru_nsignals: Number(ru.ruNsignals),
			ru_nvcsw: Number(ru.ruNvcsw),
			ru_nivcsw: Number(ru.ruNivcsw),
		};
		/* eslint-enable camelcase */
	}

	/**
	 * Update settings.
	 */
	async updateSettings({
		logLevel,
		logTags,
	}: WorkerUpdateableSettings<WorkerAppData> = {}): Promise<void> {
		logger.debug('updateSettings()');

		// Build the request.
		const requestOffset = new FbsWorker.UpdateSettingsRequestT(
			logLevel,
			logTags,
		).pack(this.#channel.bufferBuilder);

		await this.#channel.request(
			FbsRequest.Method.WORKER_UPDATE_SETTINGS,
			FbsRequest.Body.Worker_UpdateSettingsRequest,
			requestOffset,
		);
	}

	/**
	 * Create a WebRtcServer.
	 */
	async createWebRtcServer<WebRtcServerAppData extends AppData = AppData>({
		listenInfos,
		appData,
	}: WebRtcServerOptions<WebRtcServerAppData>): Promise<
		WebRtcServer<WebRtcServerAppData>
	> {
		logger.debug('createWebRtcServer()');

		if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// Build the request.
		const fbsListenInfos: FbsTransport.ListenInfoT[] = [];

		for (const listenInfo of listenInfos) {
			fbsListenInfos.push(
				new FbsTransport.ListenInfoT(
					listenInfo.protocol === 'udp'
						? FbsTransportProtocol.UDP
						: FbsTransportProtocol.TCP,
					listenInfo.ip,
					listenInfo.announcedIp,
					listenInfo.port,
					socketFlagsToFbs(listenInfo.flags),
					listenInfo.sendBufferSize,
					listenInfo.recvBufferSize,
				),
			);
		}

		const webRtcServerId = utils.generateUUIDv4();

		const createWebRtcServerRequestOffset =
			new FbsWorker.CreateWebRtcServerRequestT(
				webRtcServerId,
				fbsListenInfos,
			).pack(this.#channel.bufferBuilder);

		await this.#channel.request(
			FbsRequest.Method.WORKER_CREATE_WEBRTCSERVER,
			FbsRequest.Body.Worker_CreateWebRtcServerRequest,
			createWebRtcServerRequestOffset,
		);

		const webRtcServer = new WebRtcServer<WebRtcServerAppData>({
			internal: { webRtcServerId },
			channel: this.#channel,
			appData,
		});

		this.#webRtcServers.add(webRtcServer);
		webRtcServer.on('@close', () => this.#webRtcServers.delete(webRtcServer));

		// Emit observer event.
		this.#observer.safeEmit('newwebrtcserver', webRtcServer);

		return webRtcServer;
	}

	/**
	 * Create a Router.
	 */
	async createRouter<RouterAppData extends AppData = AppData>({
		mediaCodecs,
		appData,
	}: RouterOptions<RouterAppData> = {}): Promise<Router<RouterAppData>> {
		logger.debug('createRouter()');

		if (appData && typeof appData !== 'object') {
			throw new TypeError('if given, appData must be an object');
		}

		// Clone given media codecs to not modify input data.
		const clonedMediaCodecs = utils.clone<RtpCodecCapability[] | undefined>(
			mediaCodecs,
		);

		// This may throw.
		const rtpCapabilities =
			ortc.generateRouterRtpCapabilities(clonedMediaCodecs);

		const routerId = utils.generateUUIDv4();

		// Get flatbuffer builder.
		const createRouterRequestOffset = new FbsWorker.CreateRouterRequestT(
			routerId,
		).pack(this.#channel.bufferBuilder);

		await this.#channel.request(
			FbsRequest.Method.WORKER_CREATE_ROUTER,
			FbsRequest.Body.Worker_CreateRouterRequest,
			createRouterRequestOffset,
		);

		const data = { rtpCapabilities };
		const router = new Router<RouterAppData>({
			internal: {
				routerId,
			},
			data,
			channel: this.#channel,
			appData,
		});

		this.#routers.add(router);
		router.on('@close', () => this.#routers.delete(router));

		// Emit observer event.
		this.#observer.safeEmit('newrouter', router);

		return router;
	}

	private workerDied(error: Error): void {
		if (this.#closed) {
			return;
		}

		logger.debug(`died() [error:${error}]`);

		this.#closed = true;
		this.#died = true;

		// Close the Channel instance.
		this.#channel.close();

		// Close every Router.
		for (const router of this.#routers) {
			router.workerClosed();
		}
		this.#routers.clear();

		// Close every WebRtcServer.
		for (const webRtcServer of this.#webRtcServers) {
			webRtcServer.workerClosed();
		}
		this.#webRtcServers.clear();

		this.safeEmit('died', error);

		// Emit observer event.
		this.#observer.safeEmit('close');
	}
}

export function parseWorkerDumpResponse(
	binary: FbsWorker.DumpResponse,
): WorkerDump {
	const dump: WorkerDump = {
		pid: binary.pid()!,
		webRtcServerIds: utils.parseVector(binary, 'webRtcServerIds'),
		routerIds: utils.parseVector(binary, 'routerIds'),
		channelMessageHandlers: {
			channelRequestHandlers: utils.parseVector(
				binary.channelMessageHandlers()!,
				'channelRequestHandlers',
			),
			channelNotificationHandlers: utils.parseVector(
				binary.channelMessageHandlers()!,
				'channelNotificationHandlers',
			),
		},
	};

	if (binary.liburing()) {
		dump.liburing = {
			sqeProcessCount: Number(binary.liburing()!.sqeProcessCount()),
			sqeMissCount: Number(binary.liburing()!.sqeMissCount()),
			userDataMissCount: Number(binary.liburing()!.userDataMissCount()),
		};
	}

	return dump;
}
