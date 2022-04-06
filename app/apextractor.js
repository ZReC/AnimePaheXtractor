const { BrowserView, ipcMain } = require('electron');
const https = require('https');
const { PassThrough, EventEmitter } = require('stream');
const { promises: fs, constants: fs_consts } = require('fs');
const { Database } = require('./database');
const zlib = require('zlib');
const path = require('path');

// ffmpeg will handle m3u8 stream
const ffmpeg = require('fluent-ffmpeg');

// fix path when it is packed
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

ffmpeg.setFfmpegPath(ffmpegPath);

const defReferer = 'https://kwik.cx';
const defContentType = 'application/json';

// media library
const library = {
    get directory() { return this._directory; },
    set directory(path) { this._directory = path; },

    get database() { return this._db; },
    set database(db) { this._db = db; },

    async init() {
        this.database = await Database.open('ap'); // TODO: database should be closed at some point
    }
};

const apRequest = {
    view: (
        () => {
            const view = new BrowserView({ webPreferences: { sandbox: true } });
            view.webContents.loadURL('about:blank');
            return view;
        })(),

    completedEvent: new EventEmitter(),
    completedSymbol: Symbol(),

    prepareViewPromise: undefined,
    async prepareView() {
        if (this.prepareViewPromise instanceof Promise) {
            return await this.prepareViewPromise;
        }

        this.prepareViewPromise = new Promise(r =>
            this.completedEvent.once(this.completedSymbol, () =>
                r(true)
            )
        );

        // load hardcoded url - TODO: take into account ('.org', '.ru') TLD
        this.view.webContents.loadURL('https://animepahe.com/api?m=airing&page=1');

        const outcome = await Promise.race([
            this.prepareViewPromise,
            new Promise(r => setTimeout(r, 3e4, new Error('request timeout')))
        ]);

        // reset
        this.prepareViewPromise = undefined;
        this.completedEvent.removeAllListeners(this.completedSymbol);

        return outcome;
    },

    init() {
        this.view.webContents.session.webRequest
            .onHeadersReceived({ urls: ['https://*.animepahe.com/*'] }, (details, callback) => {
                callback({
                    responseHeaders: {
                        ...details.responseHeaders,
                        'Content-Security-Policy': [`default-src 'self' 'unsafe-inline' 'unsafe-eval' *.animepahe.com`],
                        'Access-Control-Allow-Origin': '*'
                    }
                });
            });

        this.view.webContents.session.webRequest
            .onCompleted({ urls: ['https://animepahe.com/api?*'] }, details => {
                if (details.statusCode == 200) {
                    this.completedEvent.emit(this.completedSymbol);
                };
            });

        // used when this.fetch fails - TODO: Should I make the user aware?
        this.tasks = [
            () => this.prepareView(),
            async () => (await this.view.webContents.session.clearStorageData(), await this.prepareView())
        ];
    },

    async fetch(url, test = v => /application\/json/.test(v)) {
        let result, attempts = 3;
        let tasks = this.tasks.values();

        while (attempts > 0) {
            attempts--;

            try {
                result = await Promise.race([
                    this.view.webContents
                        .executeJavaScript(
                            `fetch('${new URL(url).href}').then(v => Promise.all([v.headers.get('content-type'), v.arrayBuffer()]))`
                        ),
                    new Promise(r => setTimeout(r, 1e4, new Error('request timeout')))
                ]);
            } catch (e) { result = e; }

            if (result instanceof Array && test(result.at(0))) {
                return Buffer.from(result.at(1));
            }

            const task = tasks.next();
            if (!task.done) {
                await task.value();
            }
        }

        // error
        return result;
    },
}; apRequest.init();

async function sendRequest({
    hostname = "animepahe.com", path, referer, url,
    checkHeaders = (headers) => { return headers['content-type'] == defContentType; }
}) {
    const response = await new Promise(async resolve => {
        try {
            if (url == undefined)
                url = new URL(`https://${hostname}${path}`);
            else if (!(url instanceof URL))
                url = new URL(url);

            const headers = ['host', url.host, 'user-agent', ''];
            const timestamp = Date.now();

            if (referer){
                headers.push('referer', referer);
            }

            https.get(url.href, { headers: headers, timeout: 6e4 }, r => {
                const { statusCode } = r;
                let arr = [];
                if (statusCode == 200 && !checkHeaders || checkHeaders(r.headers)) {
                    r
                        .on('end', () => resolve(Buffer.concat(arr)))
                        .on('data', chunk => arr.push(chunk));
                } else resolve(new Error(`${statusCode} '${r.headers['content-type']}'`));
            })
                .once('error', e => resolve(e))
                .once('abort', () => resolve(new Error(`aborted after ${Math.round((Date.now() - timestamp) / 1000)}s`)));
        } catch (e) { resolve(e); }
    });

    if (response instanceof Error) {
        return new Error(`cannot gather such data`);
    }

    return response;
}

class Serie {
    /** @type {Serie[]} */
    static siblings = {};

    /** @type {Database} */
    static db;

    static async init(db) {
        this.db = db;
        await this.db.createTable('series',
            ['id', Database.TYPE.INTEGER],
            ['details', Database.TYPE.TEXT],
            ['poster', Database.TYPE.BLOB],
            ['folder', Database.TYPE.TEXT],
            ['range', Database.TYPE.TEXT]
        );
    }

    /**
     * 
     * @param {Serie} serie 
     * @param {Object} details 
     */
    static async store(serie, details) {
        const result = await this.db.select('series', ['*'], `id = ${serie.id}`);
        if (result) {
            if (result.poster)
                serie.b64Poster = result.poster;

            if (result.folder)
                serie.folder = result.folder;
        } else {
            // TODO: details unused
            this.db.insert('series', ['id', serie.id]/*, ['details', JSON.stringify(details)]*/);
        }
    }

    /**
     * @param {number} id
     * @param {...[string, any]} keyval 
     */
    static async update(id, ...keyval) {
        await this.db.update('series', `id = ${+id}`, ...keyval);
    }

    static create(id, details) {
        return this.siblings[id] = new Serie(id, details);
    }

    static getDetailsFromID(id) {
        if (id in this.siblings)
            return this.siblings[id].details;
        else
            throw new Error(`Couldn't retrieve Serie ${id} from storage`);
    }

    _b64Poster;
    /**
     * @type {string}
     * base64 poster image
     */
    get b64Poster() {
        return this._b64Poster;
    }
    set b64Poster(value) {
        this._b64Poster = `data:image/*;base64,${value.toString('base64')}`;
    }

    constructor(id, details) {
        /* -
        Details in use:
            episodes, id, poster, title,
            type, year, season, status,
        Not in use for now:
            relevance, score, session, slug,
        - */

        /**
         * @type {number} serie unique ID */
        this.id = +id;
        /**
         * @type {Object} */
        this.details = details;
        /**
         * @type {Map<number, number | {session: string, page: number}>}
         * Each page contains a number of episodes.
         * Each episode is a Map that contains a key (episode {number}) and
         * a value (session + page or pointer {number} to the episode
         * because a tape might contain more than a episode) */
        this.episodes = new Map();
        /**
         * @type {Map<number, {from: number, to: number, expires: number}>} */
        this.pages = new Map();
        /**
         * @type {number | undefined}*/
        this.tapesCount = undefined;
        /**
         * @type {number | undefined}*/
        this.lastPage = undefined;
        /**
         * @type {number | undefined}*/
        this.firstPage = 1;
        /**
         * @type {number | undefined}*/
        this.tapesPerPage = undefined;
        /**
         * @type {number}
         * `this.details.options` is usually an approximation.
         * Fetching a page provides the actual amount */
        this.totalEpisodes;
        /**
         * @type {Object[]}
         * contains options later presented to the user to
         * determinate the best match for extraction */
        this.options;

        // TODO: details unused
        Serie.store(this, /*{
            title: details.title,
            episodes: details.episodes,
            type: details.type,
            year: details.year,
            season: details.season,
            status: details.status
        }*/);
    }

    /**
     * if needed, request page and stores it into 'pages'
     * @param {number} pageNumber
     * @returns the page in question
     */
    async fetchPage(pageNumber) {
        const page = this.pages.get(pageNumber);
        if (page == undefined || page.expires < Date.now()) {
            const _tmp =
                JSON.parse(await apRequest.fetch(
                    `https://animepahe.com/api?m=release\&id=${this.id}\&sort=episode_asc\&page=${pageNumber}`)
                );

            for (const v of ['total', 'per_page', 'last_page', 'data']) {
                if (_tmp[v] == undefined)
                    throw new Error(`cannot get property ${v}`);
            }

            this.tapesCount == _tmp.total
                || (this.tapesCount = _tmp.total);
            this.tapesPerPage == _tmp.per_page
                || (this.tapesPerPage = _tmp.per_page);
            this.lastPage == _tmp.last_page
                || (this.lastPage = _tmp.last_page);

            for (const ep of _tmp.data) {
                if (ep.session == undefined) {
                    throw new Error(`cannot get property 'session' from episode`);
                }

                if (ep.episode == undefined) {
                    throw new Error(`cannot get episode number`);
                }

                const current = { session: ep.session, page: pageNumber };
                this.episodes.set(+ep.episode, current);

                // if there's more than an episode in the tape, point them to the first one
                let eps = [];
                for (const v of Object.keys(ep).filter((v) => /episode[0-9]+/.test(v))) {
                    // episode '0' means no episode
                    if (ep[v] != 0) {
                        eps.push(+ep[v]);
                        this.episodes.set(+ep[v], +ep.episode);
                    }
                }
                if (eps.length > 0) {
                    current.contains = [+ep.episode, ...eps].join('-');
                }
            }
            const expires = Date.now() + /*6hs*/216e5;
            const
                from = _tmp.data.at(0).episode,
                to = Object.keys(_tmp.data.at(-1)).reduce((p, c) => {
                    if (/episode([0-9]*)/.exec(c) && _tmp.data.at(-1)[c] > p)
                        return _tmp.data.at(-1)[c];
                    return p;
                }, from);
            this.pages.set(pageNumber, { from, to, expires });
        }
        return this.pages.get(pageNumber);
    }

    /**
     * @param {string} epList string of intervals in the form 'a-b,c,...'
     * @param {number} min
     * @param {number} max
     */
    async getEpisodeListFromIntervals(epList, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
        // reduce to valid intervals and sort
        // redundancy is handled later
        const valid = new String(epList)
            .split(',')
            .map(v => v
                .split(/:|-/)
                .filter(x => !isNaN(x) && x.length))
            .reduce((p, c) => {
                if (c.length > 0)
                    p.push(c);
                return p;
            }, [])
            .map(v => [
                Math.max(Math.min(...v, max), min),
                Math.min(Math.max(...v, min), max)
            ])
            .sort((a, b) => a.at(0) - b.at(0));

        const locatePage = async (point, pageNumber) => {
            pageNumber = Math.min(Math.max(pageNumber, this.firstPage), this.lastPage);
            const page = await this.fetchPage(pageNumber);
            let n;

            if (point < page.to && point < page.from) { // further left
                n = -1;
            } else if (point > page.from && point > page.to) { // further right
                n = 1;
            } else { // found
                return pageNumber;
            }

            if (n && pageNumber + n < this.firstPage || pageNumber + n > this.lastPage) { // best match
                return pageNumber;
            }

            return locatePage(point, pageNumber + n); // recursive search
        };

        const requiredPages = new Set();
        for (const interval of valid) {
            let pageInterval = [];

            for (const point of interval) {
                pageInterval.push(
                    await locatePage(
                        point,
                        //initial guess
                        this.tapesPerPage && ~~(point / (this.tapesPerPage + 1)) + 1, this.lastPage || this.firstPage
                    ));
            }

            // add needed pages
            for (let i = pageInterval.at(0); i <= pageInterval.at(1); i++) {
                requiredPages.add(i);
            }
        }

        // fetch 
        await Promise.all(
            Array.from(requiredPages)
                .map(v => this.fetchPage(v))
        );

        const list = new Set();
        for (const [key,] of this.episodes) {
            for (const [from, to] of valid) {
                if (key >= from && key <= to)
                    list.add(key);
            }
        }

        return list;
    }
    /**
     * TODO: will fail if session has expired
     * 
     * @param {string} session
     * @returns {Promise<Object[]>}
     */
    async fetchOptions(session) {
        const options = [];
        const buffer = await apRequest.fetch(`https://animepahe.com/api?m=links\&id=${this.id}\&session=${session}\&p=kwik`);

        for (const v of JSON.parse(buffer).data)
            for (const q in v) {
                v[q].resolution = q;
                options.push(v[q]);
            }

        if (options?.length < 1)
            throw new Error(`cannot fetch episode options`);

        return options;
    };

    /**
     * @returns {string} base64 poster image
     */
    async fetchPoster() {
        if (!this.b64Poster) {
            const url = new URL(this.details.poster);
            const buffer = await apRequest.fetch(
                url.href,
                v => /image/.test(v)
            );

            if (buffer instanceof Error)
                throw buffer;

            this.b64Poster = buffer;
            Serie.update(this.id, ['poster', buffer]);
        }
        return this.b64Poster;
    }
}

class SearchResult {
    static siblings = {};

    static async create(query) {
        if (3 > query.length)
            throw Error('query too short');

        let searchResult = SearchResult.siblings[query];
        if (!(searchResult && searchResult.expires > Date.now())) {
            const result = await apRequest.fetch(`https://animepahe.com/api?m=search\&l=8\&q=${query}`);

            if (result instanceof Error)
                throw result;

            SearchResult.siblings[query] = searchResult =
                new SearchResult(query, JSON.parse(result).data);
        }

        return searchResult;
    }

    constructor(query, data) {
        if (data) {
            this.query = query;
            this.expires = Date.now() + 1.8e6 /*30 mins*/;
            this.entries = [];

            data.forEach(v => {
                const { id } = v;
                delete v.id;

                // store/update serie
                this.entries.push(Serie.create(id, v));
            });
        } else
            throw Error('Can\'t create empty SearchResult');
    }

    getEntriesData() {
        return this.entries.map(s => {
            return {
                id: s.id, details: s.details
            };
        });
    }
}

class Extract {
    /** @type {Extract} */
    static siblings = [];

    /** @type {Database} */
    static db;

    static async init(db) {
        this.db = db;
    }

    /**
     * 
     * @param {Serie} serie 
     * @param {NumberList} epList
     * @param {Object} preferred
     * @param {function(string, any):void} updateStatus
     */
    static async create(serie, epList, preferred, updateStatus) {
        if (await fs.access(library.directory, fs_consts.X_OK).catch(() => true))
            return this.updateStatus('error', new Error(`folder "${library.directory}" doesn't exist`));

        if (!serie.folder) { //serie was not queued before
            serie.folder = serie.details.title.replace(/[^\w|\s]/g, '_').replace(/\s/g, '-');
            await Serie.update(serie.id, ['folder', serie.folder]);
        }
        const currentDir = path.join(library.directory, serie.folder);

        // also creates .data directory where temporal data is stored
        // TODO: should be set hidden in windows
        if (await fs.access(currentDir, fs_consts.X_OK).catch(() => true))
            await fs.mkdir(path.join(currentDir, '.data'), { recursive: true });

        let extract = this.siblings[serie.id];
        if (extract == undefined) {
            extract = this.siblings[serie.id] =
                new Extract(serie, currentDir, updateStatus);
        }

        extract.queue(epList, preferred);
    }

    /**
     * TODO: remove static
     * 
     * @param {Serie} serie 
     * @returns {Promise<Object>}
     */
    static async fetchExtractionDetails(serie) {
        // lookup tables
        let [audios, qualities] = [{}, {}];
        const
            firstEp = (await serie.fetchPage(1)).from,
            lastEp = (await serie.fetchPage(serie.lastPage)).to;

        let ep = serie.episodes.get(lastEp);
        if (typeof ep == "number") { // a tape that cointains more than an episode
            ep = serie.episodes.get(ep);
        }
        const epOptions = await serie.fetchOptions(ep.session);
        epOptions.forEach(v => {
            if (v.audio in audios == false) {
                switch (v.audio) {
                    case 'jpn':
                        audios[v.audio] = 'Japanese';
                        break;
                    case 'eng':
                        audios[v.audio] = 'English';
                        break;
                    default:
                        audios[v.audio] = v.audio;
                }
            }

            qualities[~~v.resolution] = true;
        });
        // sort and add description to qualities
        qualities = Object.keys(qualities)
            .sort((a, b) => a - b)
            .reduce((p, c) => {
                let desc;

                if (c < 300)
                    return p;
                else if (c < 400)
                    desc = `Low`;
                else if (c < 700)
                    desc = `Standard`;
                else if (c < 1000)
                    desc = `HD`;
                else if (c < 1600)
                    desc = `Full HD`;
                else if (c < 3000)
                    desc = `Ultra HD`;
                else
                    return p;

                return { ...p, [c]: `${desc} (${c}p)` };
            }, {});

        if (serie.tapesCount > 1 || Object.keys(qualities).length < 1)
            qualities = { 0: 'Lowest', ...qualities, Infinity: 'Highest' };

        return {
            tapesCount: serie.tapesCount,
            range: { first: firstEp, last: lastEp },
            audios, qualities
        };
    };

    /**
     * @param {URL} epURL 
     * @returns {Promise<URL>} the stream url
     */
    static async parseEpisodeURL(epURL) {
        if (!(epURL instanceof URL))
            return new Error('is not a URL');

        try {
            const result = new String(await sendRequest({
                hostname: epURL.hostname, path: epURL.pathname, referer: defReferer,
                checkHeaders: (h) => { return /text\/html/.test(h['content-type']); } // only html content
            }));

            const url = eval( // this piece of code may break at some point
                /(eval)(\(f.*?)(\n<\/script>)/s // search for anon function
                    .exec(result)[2] // take second group from regex output
                    .replace('eval', '') // remove 'eval' string to execute anon
            ).match(/https.*?m3u8/); // look for the url

            return new URL(url);
        } catch (err) { return err; }
    };

    static packJSON(obj) {
        return new Promise(res => {
            zlib.deflate(JSON.stringify(obj), (e, b) => res(e ? false : b));
        });
    }

    static unpackJSON(buff) {
        return new Promise(res => {
            zlib.inflate(buff, (e, b) => res(e ? false : JSON.parse(b.toString())));
        });
    }

    /**
     * @param {string} str in the form `hh:mm:ss`
     * @returns {number} seconds
     */
    static timeToSeconds(str) {
        const arr = str.split(':');
        let secs = 0;
        for (let i = 0; i < arr.length; i++)
            secs += arr[i] * 60 ** (arr.length - i - 1);
        return secs;
    };

    /**
     * 
     * @param {Serie} serie
     * @param {string} currentDir
     * @param {function(string, any):void} updateStatus
     */
    constructor(serie, currentDir, updateStatus) {
        /** @type {Serie} */
        this.serie = serie;
        /** @type {Set<>} */
        this.list = new Set();
        /** @type {Array<>} */
        this.queued = [];

        /** @type {string} */
        this.currentDir = currentDir;

        /** @type {function(ep: number, ...args[]):Promise<any>} */
        this.updateStatus = updateStatus;

        // TODO: only executes once, will be dormant until an event occurs
        this.queueEvent = new EventEmitter();
        this.symbolUpdate = Symbol();
        this.runQueue();
    }

    /**
     * @param {string} epList 
     * @param {string} epList
     */
    async queue(epList, preferred) {
        // gather episode set within the interval
        const list = await this.serie.getEpisodeListFromIntervals(epList);
        if (list.size > 0) {
            list.forEach(v => {
                if (!this.list.has(v)) {
                    this.list.add(v);
                    this.queued.push([v, preferred]);
                }
            });
            this.queueEvent.emit(this.symbolUpdate);
            this.updateStatus('left', this.queued.length);
        }
    }

    async runQueue() {
        let p;
        do {
            p = new Promise(r => this.queueEvent.once(this.symbolUpdate, () => r(true)));

            while (this.queued.length > 0) {
                const current = this.queued.pop();
                this.updateStatus('left', this.queued.length);
                try {
                    const [num, preferred] = current;

                    let ep = this.serie.episodes.get(num);

                    if (ep == undefined) { // discard the unreachable episode
                        throw `episode ${num} dropped`;
                    } else if (typeof ep == "number") { // get the root episode
                        ep = this.serie.episodes.get(ep);
                    }

                    const filename = `${ep.contains || num}.mp4`;
                    const outputFile = path.join(this.currentDir, filename);
                    const tempFolder = path.join(this.currentDir, '.data', num.toString());

                    // if outputFile & tempFolder exist, most likely outputFile didn't finish to compile
                    // otherwise ignore, most likely it succeeded
                    if (await fs.access(outputFile, fs_consts.F_OK).then(() => true, () => false)) {
                        if (await fs.stat(tempFolder).then(s => s.isDirectory(), () => false)) {
                            await fs.unlink(outputFile);
                        } else throw `'${filename}' already exists, ignored`;
                    }

                    const options = await this.serie.fetchOptions(ep.session);
                    const [url, option] = this.getBestMatch(options, preferred);

                    this.updateStatus('option', [option.audio, option.resolution]);
                    this.updateStatus('progress', 0);

                    const status = await this.fromURL(
                        false,
                        await Extract.parseEpisodeURL(new URL(url)),
                        tempFolder,
                        outputFile,
                        () => {
                            this.updateStatus('current', num);
                            this.updateStatus('start');
                        }
                    );

                    if (status instanceof Error) // TODO: may need to clean up first
                        throw status.message;

                    if (await fs.access(outputFile, fs_consts.F_OK).catch(() => true))
                        throw new Error(`output file doesn't exist`);

                    // clean up, notify & continue
                    await fs.rm(tempFolder, { recursive: true });
                } catch (err) {
                    if (err instanceof Error) {
                        this.updateStatus('error', err.message);

                        // TODO: possible while(true)
                        this.queued.push(current);
                    } else {
                        this.updateStatus('warning', err);
                    }
                }
                this.updateStatus('end');
            }
            // nothing left so far
            this.updateStatus('current', undefined);
            this.updateStatus('left', 0);
        } while (await p);
    }

    /**
     * @param {Object[]} options
     * @returns {Object}
     */
    getBestMatch(options, { audio, quality }) {
        if (Object.keys(options).length > 0) {
            const tree = options.reduce((p, c) => {
                return { ...p, [c.audio]: { ...p[c.audio], [c.resolution]: c.kwik } };
            }, {});

            const branch = tree[audio] || tree['jpn'] || tree[Object.keys(tree)[0]];

            const leaf = branch[
                Object.keys(branch).reduce((p, c) => {
                    // ceil or closest
                    return p < +quality ? c : p;
                })];

            const url = new URL(leaf); // test if it is a URL

            return [url.href, options.find((v) => v.kwik.includes(url.pathname))];
        } else
            throw new Error(`couldn't determine best match`);
    }

    /**
     * @param {boolean} wipeCache make it destroy the data stored in tempFolder
     * @param {URL} streamURL where data is gathered from
     * @param {string} tempFolder folder to store temp data
     * @param {string} outputFile final container
     * @param {function():void} announce called when data begins to flow
     * @returns 
     */
    async fromURL(wipeCache = false, streamURL, tempFolder, outputFile, announce) {
        // create folder if if needed
        await fs.mkdir(tempFolder, { recursive: true }).catch(
            async e => {
                if (e.errno == -4075 && (await fs.stat(tempFolder)).isDirectory() == false)
                    throw 'an object is on the road'; // can't create folder
            });

        const
            statusPath = path.join(tempFolder, 'status'),
            keyPath = path.join(tempFolder, 'key'),
            M3UPath = path.join(tempFolder, '.m3u8');

        let [status, [M3Umetadata, idxM3Umetadata]] = await Promise.all([
            fs.readFile(statusPath)
                .then(async buffer => await Extract.unpackJSON(buffer))
                .catch(() => false),
            fs.readFile(M3UPath)
                .then(async buffer => {
                    const { 1: meta, index } =
                        buffer.toString().match(/#EXT-X-METADATA:(.+)/);

                    return [
                        await Extract.unpackJSON(Buffer.from(meta, 'base64')) || {},
                        index + 16 // metadata start point
                    ];
                })
                .catch(() => [{}])
        ]);

        let isResumable = status && M3Umetadata
            ? M3Umetadata.streamURL == streamURL.href
                ? true
                : undefined
            : false;

        if (isResumable != true || wipeCache) { // seems it may not be able to resume, time to collect data
            // fetch M3U file
            let M3U =
                (await sendRequest({
                    url: streamURL, referer: defReferer,
                    checkHeaders: h => h['content-type'].search('application/') != -1
                })
                    .then(v => v instanceof Error ? Promise.reject(v.message) : v)
                    .catch(e => Promise.reject(new Error(`'${streamURL.host}': ${e.message}`)))
                ).toString();

            // get XKEY's URI property
            const XKEY = M3U.match(/#EXT-X-KEY:(.+)/)
                ?.at(1).split(',')
                ?.reduce((p, c) => { c = c.replace(/"+/g, '').split('='); p[c[0]] = c[1]; return p; }, { URI: undefined });

            // fetch key
            const newKey =
                XKEY.URI != undefined && await sendRequest({
                    url: new URL(XKEY.URI), referer: defReferer,
                    checkHeaders: h => h['content-type'].search('application/') != -1
                })
                    .then(v => v instanceof Error ? Promise.reject(v.message) : v)
                    .catch(e => Promise.reject(new Error(`'${streamURL.host}': ${e.message}`)));

            // parse segments as properties
            const newStatus = M3U.match(/#EXTINF:.*\n.+/g)
                ?.reduce((p, c, i) => { p[i] = { url: c.match(/\n(.+)/)?.at(1) }; return p; }, {});

            if (!(newStatus instanceof Object))
                throw `cannot parse needed segments`;

            const newStatusCount = Object.keys(newStatus).length;

            /** here we assume the 2^128 collision risk so we may end up with a funny, mixed tape :D
             *  I really want to minimize the data exchanged with the server */
            if (wipeCache || isResumable == false
                || newStatusCount != M3Umetadata.count
                || !(M3Umetadata.key && newKey) || Buffer.compare(Buffer.from(M3Umetadata.key, 'base64'), newKey)
            ) {
                // update status
                status = newStatus;

                // modify M3U
                if (XKEY.URI)
                    M3U = M3U.replace(XKEY.URI, 'key');
                for (const k in status)
                    M3U = M3U.replace(status[k].url, k);

                // update M3U's metadata
                M3Umetadata.streamURL = streamURL.href;
                M3Umetadata.count = newStatusCount;
                if (newKey instanceof Buffer)
                    M3Umetadata.key = newKey.toString('base64');

                // store M3U file
                Extract.packJSON(M3Umetadata)
                    .then(async buffer => {
                        fs.writeFile(M3UPath,
                            `${M3U}${M3U.at(-1) == '\n' ? '' : '\n'}` +
                            // thanks to the 'novelties' of M3U, store metadata inside it
                            `#EXT-X-METADATA:${buffer.toString('base64')}`);
                    });
            } else {
                // should continue, but update files
                // swap urls with new ones
                for (const key in status)
                    status[key].url = newStatus[key].url;

                M3Umetadata.streamURL = streamURL.href;

                // update stored metadata
                Extract.packJSON(M3Umetadata)
                    .then(async buffer => {
                        await fs.truncate(M3UPath, idxM3Umetadata);
                        await fs.appendFile(M3UPath, buffer.toString('base64'));
                    });
            }
            // store status
            Extract.packJSON(status)
                .then(async buffer => fs.writeFile(statusPath, buffer));
        }

        // only keep segments that haven't finished downloading
        const segmentKey = [];
        for (const key in status)
            ('done' in status[key] && await fs.stat(path.join(tempFolder, key))
                .then(
                    s => s.isFile(),
                    () => false
                )
            ) || segmentKey.push(key);

        const segumentsCount = segmentKey.length;
        let load = M3Umetadata.count - segumentsCount;

        if (segumentsCount > 0) {
            announce();
            let slots = [], trouble = [];
            // it will resolve when segmentsKey is empty
            await new Promise(async res => {
                const populateSlots = (slot) => {
                    if (segmentKey.length == 0)
                        return res();

                    // pick a random key (also it is removed)
                    const [itemKey] = segmentKey.splice(~~(segmentKey.length * Math.random()), 1);
                    const url = status[itemKey].url;
                    const itemSlot = slot || slots.length;

                    slots[itemSlot] =
                        this.fetchSegment(url, path.join(tempFolder, itemKey), p => this.updateStatus('progress', (load = load + p) / M3Umetadata.count))
                            .then(async () => {
                                status[itemKey].done = true;

                                // store changes
                                await Extract.packJSON(status)
                                    .then(async buffer => {
                                        await fs.writeFile(statusPath, buffer);
                                    });
                            })
                            .catch(err => {
                                // update attempt number
                                status[itemKey].attempt = status[itemKey].attempt + 1 || 1;

                                if (status[itemKey].attempt <= 3) // up to 3 attempts
                                    segmentKey.push(itemKey);
                                else
                                    trouble.push[{ culprit: itemKey, error: err }];
                            })
                            .finally(() => populateSlots(itemSlot));

                    if (slots.length < 7) // max number of slots
                        populateSlots();
                }; populateSlots();
            });
            // end segments left if any
            await Promise.all(slots);

            if (trouble.length > 0) // not okay, somebody toucha my spaghet
                throw new Error(`failed segments count: ${trouble.length}`);
        }

        // (over)write key file
        await fs.writeFile(keyPath, Buffer.from(M3Umetadata.key, 'base64'));

        // compile .m3u8 into an MP4 container
        // ffmpeg isn't used to download the playlist for many reasons like skipping .ts files
        let duration;
        return new Promise(resolve => {
            ffmpeg()
                .addInput(path.join(tempFolder, '.m3u8'))
                .inputOption('-allowed_extensions ALL')
                .videoCodec('copy')
                .audioCodec('copy')
                .output(outputFile).format('mp4')
                .on('error', resolve)
                .on('end', resolve)
                .on('codecData', data => duration = Extract.timeToSeconds(data.duration))
                .on('progress', p => {
                    const percent = Extract.timeToSeconds(p.timemark) / duration;
                    this.updateStatus('progress', (percent < 1 ? percent : 1));
                })
                .run();
        });
    }

    async fetchSegment(url, filePath, statusCallback) {
        // writeStream from created/truncated file
        const wstream = (await fs.open(filePath, 'w')).createWriteStream();
        const result =
            await new Promise((resolve, reject) => {
                https.get(url, { headers: ['Host', new URL(url).host, 'user-agent', '', 'Referer', defReferer] },
                    response => {
                        const { statusCode, statusMessage } = response;
                        response.pipe(wstream);

                        if (statusCode == 200) {
                            const totalBytes = +response.headers['content-length'];
                            if (totalBytes > 0)
                                response.pipe(new PassThrough().on('data', c => {
                                    statusCallback(c.length / totalBytes);
                                }));

                            response.on('end', () => resolve());
                        } else
                            reject(new Error(`status code ${statusCode} '${statusMessage}'`));
                    }
                ).on('error', err => reject(err));
            });

        return result;
    }
}

// Initialize
(async () => {
    await library.init();
    await Serie.init(library.database);
    await Extract.init(library.database);

    ipcMain.handle('extract:fetchExtrationDetails', async (_, serieID) => {
        try {
            return await Extract.fetchExtractionDetails(Serie.siblings[serieID]);
        } catch (err) { return err; }
    });

    ipcMain.handle('serie:getDetailsFromID', (_, serieID) => {
        try {
            return Serie.getDetailsFromID(serieID);
        } catch (err) { return err; }

    });

    ipcMain.handle('serie:fetchPoster', async (_, serieID) => {
        try {
            return await Serie.siblings[serieID].fetchPoster();
        } catch (err) { return err; }
    });

    ipcMain.handle('extract:start', ({ sender }, serieID, epList, preferred) => {
        const serie = Serie.siblings[serieID];
        try {
            if (!(serie instanceof Serie))
                throw new Error(`Coudn't retrieve serie`);

            Extract.create(
                serie, epList, preferred,
                (type, msg) => sender.send(`extract:updateStatus:${+serie.id}`, [type, msg]));

            return `"${serie.title}" extraction has started`;
        } catch (err) { return err; }
    });

    ipcMain.handle('extract:openFolder', (e, serieID) => {
        ipcMain.emit('command:open', e, `file://${Extract.siblings[new Number(serieID)].currentDir}`);
    });

    ipcMain.handle('search:query', async (_, query) => {
        try {
            const searchResult = await SearchResult.create(query);
            if (searchResult instanceof SearchResult)
                return searchResult.getEntriesData();

            throw searchResult || new Error('something went wrong');
        } catch (err) { return err; }
    });
})();

module.exports.library = library;