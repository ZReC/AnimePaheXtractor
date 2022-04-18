/** Check URL */
function testURL(url) {
  try {
    const oURL = new URL(url);
    return /http/.test(oURL.protocol);
  } catch {
    return false;
  }
}

/** async requestAnimationFrame */
async function requestAnimationFrameAsync() {
  await new Promise(r => window.requestAnimationFrame(() => r()));
}

class Header {
  static frame = document.querySelector('header');
  static controls = [
    [this.frame.querySelector('.controls.minimize'), 'mainWindow:minimize'],
    [this.frame.querySelector('.controls.close'), 'mainWindow:close'],
  ];

  static buttons = {
    searchButton: this.frame.querySelector('.search'),
    extractButton: this.frame.querySelector('.extract'),
    homeButton: this.frame.querySelector('.home'),
  };

  static init() {
    this.controls.forEach((v) => {
      const [control, channel] = v;
      control.addEventListener('click', () =>
        electron.send(channel));
    });
  }

} Header.init();

class EpRange {
  /**
   * 
   * @param {number} from 
   * @param {HTMLElement} eFrom
   * @param {number} to
   * @param {HTMLElement} eTo
   */
  constructor(from, eFrom, to, eTo) {
    if (from > +to)
      throw new Error(`"from" is greater than "to"`);

    this.from = new EpRange.Limit(eFrom);
    this.to = new EpRange.Limit(eTo);
    this.setupLimit(from, to);
  }

  setupLimit(from, to) {
    this.from.setup(from, (v) => +v >= from && +v <= this.to.eHTML.value);
    this.to.setup(to, (v) => +v >= this.from.eHTML.value && +v <= to);
  }

  static Limit = class {
    /**
     * @param  {HTMLElement} eHTML
     */
    constructor(eHTML) {
      this.eHTML = eHTML;
      this.test = () => true;

      this.eHTML.addEventListener('focusin', () => this.focusIn());
      this.eHTML.addEventListener('beforeinput', this.beforeInput);
      this.eHTML.addEventListener('input', () => this.input());
      this.eHTML.addEventListener('focusout', () => this.focusOut());
    }
    /**
     * @param  {number} num
     * @param  {function()} test
     */
    setup(num, test) {
      this.eHTML.value = this.num = this.last = num;
      this.test = test;
    }

    clearClasses() {
      this.eHTML.classList.remove('ok', 'err');
    }

    focusIn() {
      this.eHTML.classList.add('ok');
    }

    beforeInput(e) {
      if (e.data && /([^0-9]+)/g.test(e.data))
        e.preventDefault();
    }

    input() {
      this.clearClasses();
      this.eHTML.classList.add(this.test(this.eHTML.value) ? 'ok' : 'err');
    }

    focusOut() {
      this.clearClasses();
      const value = +this.eHTML.value.replace(/([^0-9]+)/g, ''); // destroys anything that is not a number

      if (this.test(value))
        this.eHTML.value = this.last = value;
      else // out of range
        this.eHTML.value = this.last;
    }
  };
}

class OptionDropdown {
  /**
   * @param {HTMLElement} eHTML 
   * @param {Array} items 
   */
  constructor(eHTML, items) {
    /** @type {HTMLElement} */
    this.eHTML = eHTML;
    if (items instanceof Array)
      this.setup(items);

    this.eHTML.addEventListener('click',
      (e) => this.handle(e));
  }
  /**
   * @param {Array} items 
   */
  setup(items) {
    this.eHTML.innerHTML = '';
    this.eHTML.classList.remove('deploy');

    for (const [k, v] of Object.entries(items)) {
      const item = document.createElement('div');
      item.classList.add('item');
      item.textContent = v;
      item.setAttribute('data-value', k);
      this.eHTML.appendChild(item);
    }

    this.currentItem = this.eHTML.firstChild;
  }

  /**
   * @type {string}
   * @returns {string}
   */
  get value() {
    return this.currentItem.getAttribute('data-value');
  }
  set value(v) {
    this.currentItem.setAttribute('data-value', v);
  }

  handle({ target, currentTarget }) {
    if (target == currentTarget)
      currentTarget.classList.add('deploy');
    else {
      this.currentItem = target;
      currentTarget.classList.remove('deploy');
    }
  }

  /** 
   * @type {HTMLElement}
   * @returns {HTMLElement} option selected by the user
   */
  get currentItem() {
    return this._currentItem;
  }

  set currentItem(item) {
    if (item instanceof HTMLElement) {
      if (this._currentItem instanceof HTMLElement)
        this._currentItem.classList.remove('selected');

      item.classList.add('selected');
      this._currentItem = item;
    }

  }

}

const tabs = {
  list: [],
  current: 0,

  /**
   * @param {string} frameID
   * @param {SVGSVGElement} button
   * @param {function} init
   * @returns 
   */
  add(frameID, button, init) {
    const tab = new this.tab(frameID, button, this.list.length);
    if (button.classList.contains('selected')) {
      tab.frame.classList.add('show');
      this.current = this.list.length;
    }
    else {
      tab.frame.style.display = 'none'; // Not visible by default
    }
    init?.call(tab);
    this.list.push(tab);

    return tab;
  },

  async setCurrentTab(nTab) {
    // do not change tab if it is the same
    if (this.current != nTab) {
      const origen = this.current > nTab;

      this.list[tabs.current].button.classList.remove('selected');
      this.list[nTab].button.classList.add('selected');

      await Promise.all[
        this.list[tabs.current].show(false, origen),
        this.list[nTab].show(true, !origen)
      ];
      this.current = nTab;
    }
  },

  /**
   * @param {string} frameID 
   * @param {SVGSVGElement} button 
   * @param {number} order
   */
  tab: function (frameID, button, order) {
    if (!(button instanceof SVGSVGElement))
      throw 'button is not an HTMLElement';

    this.frame = document.getElementById(frameID);

    if (!(this.frame instanceof HTMLElement))
      throw `cannot get HTMLElement of id '${frameID}'`;

    this.button = button;
    button.addEventListener('click', () => tabs.setCurrentTab(order));
  }
};

tabs.tab.prototype.show = async function (status, origen) {
  this.frame.style.transition = 'none';
  this.frame.style.top = `${origen ? '-' : ''}100%`;

  await requestAnimationFrameAsync();

  this.frame.style.transition = '';
  status && (this.frame.style.display = '');
  await requestAnimationFrameAsync();


  if (status) {
    this.frame.classList.add('show');
  } else {
    this.frame.classList.remove('show');
    await new Promise((r) => {
      this.frame.addEventListener('transitionend',
        () => r(), { once: true });
    });
    this.frame.style.display = 'none';
  }
};

const searchTab = tabs.add('searchTab', Header.buttons.searchButton);

const extractTab = tabs.add('extractTab', Header.buttons.extractButton, function () {
  /** @type {Object<number, ExtractItem>} */
  this.items = {};
  this.eQueue = this.frame.querySelector('.queue');
  this.addItem = async (serieID, epList, audio, quality) => {
    const promises = [electron.invoke('extract:start', serieID, epList, { audio, quality })];
    if (this.items[serieID] == undefined) {
      this.items[serieID] = new ExtractItem(serieID, this.eQueue);
      promises.push(this.items[serieID].setup());
    }
    await Promise.all(promises);
  };
});

const homeTab = tabs.add('homeTab', Header.buttons.homeButton, function () {
  /** @type {HTMLElement} */
  this.result = this.frame.querySelector('.principal .updater .result');
  this.check = this.frame.querySelector('.principal .updater .check');

  // startup check
  this.updateCheck = () => {
    this.result.classList.contains('show') && this.result.classList.remove('show');
    this.check.classList.add('show');

    electron.invoke('updater:check').then(r => {
      const [innerHTML, buttonListener] = (() => {
        if (r.severity != 0) {
          const [color, title, text] =
            r.severity == 1 && ['green', 'Small tweaks or bug fixes', 'PATCH'] ||
            r.severity == 2 && ['yellow', 'Low severity, non-crucial new features', 'MINOR'] ||
            r.severity == 3 && ['red', 'High severity, the application might not work without this update', 'MAJOR'] ||
            ['grey', 'Not implemented', 'UNKNOWN'];

          return [
            `<div><span style="font-weight: bold; cursor: help; color: ${color}" title="${title}">${text}</span></span> update v${r.version} found</div>
                        <div class="button">
                            <div class="bg"></div>
                            <div class="text">update now</div>
                        </div>`,
            () => this.updateDownload()
          ];
        }

        return [
          `<div>You already have the latest update ^w^</div><div class="button">recheck</div>`,
          () => this.updateCheck()
        ];
      })();
      this.check.classList.remove('show');

      this.result.innerHTML = innerHTML;
      this.result.querySelector('.button')?.addEventListener('click', buttonListener, { once: true });
      this.result.classList.add('show');
    });
  }; this.updateCheck();

  this.updateDownload = async () => {
    const button = this.result.querySelector('.button');
    const bg = button.querySelector('.button .bg');
    const text = button.querySelector('.button .text');
    bg.style.pointerEvents = 'none';
    bg.style.width = '0%';
    text.textContent = 'starting download';

    electron.on('updater:download-progress', v => {
      text.textContent = `${parseFloat(v).toFixed(2)}%`;
      bg.style.width = `${v}%`;
    });

    // wait for updater to download
    const download = await electron.invoke('updater:download');

    // reset result style
    bg.style = '';
    electron.removeAllListeners('updater:download-progress');

    if (download) {
      bg.style.backgroundColor = 'darkgreen';
      text.textContent = 'install and relaunch';
      button.addEventListener('click', () => electron.send('updater:install'), { once: true });
    } else {
      bg.style.backgroundColor = 'darkred';
      text.textContent = 'fatal error, recheck?';
      button.addEventListener('click', () => this.updateCheck(), { once: true });
    }
  };

  this.frame.querySelector('.status-bar .github-link').addEventListener('click', () => electron.send('social:repo'));
});

class ExtractItem {
  static parent = extractTab.eQueue;

  static template = `
        <div class="background"></div>
            <div class="flash-bar"></div>
            <div class="info">
                <div class="progress">
                    <div></div>
                </div>
                <div class="details">
                    <div class="title"></div>
                    <div class="status">
                        <div class="h1"></div>
                        <div class="h2"></div>
                    </div>
                </div>
            <div class="controls">
                <svg class="control folder" viewBox="0 0 24 24">
                    <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="currentColor"></path>
                </svg>
            </div>
        </div>`;

  constructor(id) {
    this.id = id;

    const base = document.createElement('div');
    base.classList.add('item');
    base.innerHTML = ExtractItem.template;

    this.background = base.querySelector('.background');

    this.flashBar = base.querySelector('.flash-bar');

    const info = base.querySelector('.info');
    this.progress = info.querySelector('.progress div');
    const details = info.querySelector('.details');
    this.title = details.querySelector('.title');
    const status = details.querySelector('.status');
    this.h1 = status.querySelector('.h1');
    this.current = 'DONE';
    this.left = '0';
    this.stats = status.querySelector('.h2');

    const controls = base.querySelector('.controls'); /* TODO */
    this.folder = controls.querySelector('.folder');
    this.folder.addEventListener('click',
      e => e.currentTarget == this.folder && this.openFolder()
    );

    this.title.textContent = '';
    this.setCurrent();
    this.stats.textContent = '-';

    ExtractItem.parent.prepend(base);
    this.base = base;
    electron.on(`extract:updateStatus:${this.id}`, (status) => this.updateStatus(status));
  }

  setCurrent(current, left) {
    // store variables if needed
    current != undefined && (this.current = current);
    left != undefined && (this.left = left);

    this.h1.textContent = `${this.current} · [${this.left} left]`;
  }

  show() {
    requestAnimationFrame(
      () => requestAnimationFrame(
        () => {
          this.base.classList.add('show');
        }
      ));
  }

  toggleFlashBar(forceStop) {
    requestAnimationFrame(() => {
      const tEnd = () =>
        requestAnimationFrame(() => {
          this.flashBar.classList.remove('flash');
          requestAnimationFrame(() =>
            this.flashBar.classList.add('flash')
          );
        }); tEnd();
      if (!this.flashBar.ontransitionend && !forceStop) {
        this.flashBar.ontransitionend = tEnd;
      } else
        this.flashBar.ontransitionend = undefined;
    });
  }

  openFolder() {
    electron.invoke(`extract:openFolder`, this.id);
  }

  updateStatus([type, msg]) {
    switch (type) {
      case 'option':
        this.h1.textContent = ~~(Math.random() * 64) ? 'STARTING' : 'START:DASH!!';
        this.stats.textContent = `[ ${msg[0].toUpperCase()} ] ${msg[1]}p`;
        this.toggleFlashBar();
        break;
      case 'current':
        this.setCurrent(msg == undefined ? 'DONE' : `TAPE #${msg}`);
        break;
      case 'left':
        this.setCurrent(undefined, msg);
        break;
      case 'start':
        this.toggleFlashBar(true);
        break;
      case 'end':
        this.progress.style.width = 0;
        this.toggleFlashBar(true);
        break;
      case 'progress':
        this.progress.style.width = `${msg * 100}%`;
        break;
      case 'error':
        console.error(msg);
        break;
      case 'warning':
        console.log(msg);
        break;
      default:
        break;
    }
  }

  async loadPoster() {
    const b64Poster = await electron.invoke('serie:fetchPoster', this.id);
    if (b64Poster instanceof Error)
      this.background.classList.add('no-image');
    else {
      this.background.style.backgroundImage = `url(${b64Poster})`;
      this.background.classList.add('has-image');
    }
  }

  async setup() {
    const details = await electron.invoke('serie:getDetailsFromID', this.id);
    if (details instanceof Error)
      throw details;

    this.title.textContent = details.title;
    await this.loadPoster();
    this.show();
  }
}

class ExtractDialog {
  static async loadPoster(id) {
    this.ePosterLoading.classList.add('show');

    const b64Poster = await electron.invoke('serie:fetchPoster', id);

    if (typeof b64Poster === "string") {
      this.ePoster.style.backgroundImage = `url(${b64Poster})`;
      this.ePoster.classList.add('show');
    } else {
      this.ePoster.classList.add('not-found');
    }
    this.ePosterLoading.classList.remove('show');
  }

  static async fetchDetails() {
    const { currentSerieID: id } = this;

    if (this.eBase.classList.contains("show")) {
      this.btnFetchDetails.classList.remove('show');
      this.eFetchLoading.classList.add('show');
      const extractionDetails = await electron.invoke('extract:fetchExtrationDetails', id);
      if (extractionDetails instanceof Error) {
        this.eFetchLoading.classList.remove('show');
        this.btnFetchDetails.classList.add('show');
      } else
        this.setExtractionDetails(id, extractionDetails);
    }
  }

  static async setExtractionDetails(serieID, { tapesCount, range, audios, qualities }) {
    if (this.currentSerieID === serieID) {
      this.extractOptions.wrapper.classList.add('show');

      this.eFetchLoading.classList.remove('show');

      this.extractOptions.epRange.setupLimit(range.first, range.last);
      this.extractOptions.rangeWrapper.style.display = tapesCount == 1 ? 'none' : '';

      const { audio, quality } = this.extractOptions;
      audio.setup(audios);
      quality.setup(qualities);
    }
  }

  static show({ currentTarget }) {
    const { id } = currentTarget;
    const { title, episodes, season, year, type, status, poster } = currentTarget.details;

    if (this.currentSerieID !== id) {
      this.currentSerieID = id;

      // reset some values
      this.ePoster.style.backgroundImage = '';
      this.ePoster.classList.remove('show', 'not-found');
      this.extractOptions.wrapper.classList.remove('show');
      this.btnFetchDetails.classList.remove('show');
      this.eFetchLoading.classList.remove('show');
      this.btnFetchDetails.style.transition = 'none';

      window.requestAnimationFrame(() => {
        this.btnFetchDetails.style = '';
        this.btnFetchDetails.classList.add('show');

        this.eTitle.textContent = title || `Finally, ZReC got isekai'd !!`;

        if (testURL(poster)) {
          this.loadPoster(id);
        } else
          this.ePoster.classList.add('not-found');

        if (type == 'Movie')
          this.eType.textContent = type;
        else if (type)
          this.eType.textContent =
            `${type} ~ ${episodes > 0
              ? (`${episodes} episode${episodes != 1 ? 's' : ''}`)
              : 'unknown episodes count'}`;
        else
          this.eType.textContent = `unknown type`;

        if (year)
          this.ePremiere.textContent = `${season || ''} ${year}`;
        else
          this.ePremiere.textContent = 'unknown release date';

        this.eStatus.textContent = status || 'unknown status';

        // Display dialog
        this.eBase.classList.add('show');
      });
    } else { // Sameone than last time, only needs to show
      this.eBase.classList.add('show');
    }
  }

  static async hide() {
    this.eBase.classList.remove('show');
    await new Promise((resolve) => {
      this.eBase.addEventListener('transitionend',
        () => resolve(), { once: true });
    });
  }

  static init() {
    this.eBase = document.getElementById('extractDialog');
    this.eBg = this.eBase.querySelector('.background');
    this.eTitle = this.eBase.querySelector('.title');
    this.ePoster = this.eBase.querySelector('.poster');
    this.ePosterLoading = this.eBase.querySelector('.loading');
    this.eType = this.ePoster.querySelector('.type');
    this.ePremiere = this.ePoster.querySelector('.premiere');
    this.eStatus = this.ePoster.querySelector('.status');
    this.currentSerieID;

    this.btnFetchDetails = this.eBase.querySelector('#btnFetchDetails');
    this.eFetchLoading = this.eBase.querySelector('.fetch-loading.loading');
    this.btnExtract = this.eBase.querySelector('#btnExtract');

    this.extractOptions = {
      wrapper: document.getElementById('extractOptions'),
      rangeWrapper: document.getElementById('eoRange'),
      epRange: new EpRange(1, document.getElementById('eoRangeMin'), 12, document.getElementById('eoRangeMax')),
      audio: new OptionDropdown(document.getElementById('eoLanguage')),
      quality: new OptionDropdown(document.getElementById('eoQuality'))
    };

    // fetchDetails button
    this.btnFetchDetails.addEventListener('click',
      () => this.fetchDetails());

    // hide dialog when..
    this.eBg.addEventListener('click',
      e => e.target === e.currentTarget && this.hide());

    // extract button
    this.btnExtract.addEventListener('click', async () => {
      const currentSerieID = this.currentSerieID;
      const { from, to } = this.extractOptions.epRange;
      const { audio, quality } = this.extractOptions;
      await Promise.all([this.hide(), tabs.setCurrentTab(1)]);
      await extractTab.addItem(
        currentSerieID,
        `${from.eHTML.value}:${to.eHTML.value}`,
        audio.value, quality.value
      );
    });

  }
} ExtractDialog.init();

// the code down below must be refactored 15%
const search = {

  init() {
    this.searchTab = document.getElementById('searchTab');
    this.searchResults = this.searchTab.querySelector('.search-results');

    this.searchBar = {};
    const base = this.searchBar.base = this.searchTab.querySelector('.search-bar');

    this.searchBar.input = base.querySelector('.input');
    this.searchBar.button = base.querySelector('.btn');
    this.searchBar.loading = base.querySelector('loading');

    const { input, button, loading } = this.searchBar;

    const search = async () => {
      base.classList.add('disabled');
      const q = input.value.toLowerCase();

      const id = `searchResult-${q.replace(' ', '-')}`;
      if (document.getElementById(id)) {
        // TODO: should focus item if exists
      } else {
        const results = await electron.invoke('search:query', q);
        if (results instanceof Error)
          console.error(results);
        else
          addResultTree(q, id, results, this.searchResults);
      }

      base.classList.remove('disabled');
    };
    button.addEventListener('click', search);

    // input events not implemented yet 80%

    const sanitize = (e, data) => {
      const plain = data.getData('text/plain')
        .match(/([0-9a-zA-Z-_]+)/g)
        .reduce((p, v) => p + ' ' + v);

      if (plain)
        document.execCommand('insertText', false, plain);
      e.preventDefault();
    };

    input.addEventListener('paste', e => sanitize(e, e.clipboardData));
    input.addEventListener('drop', e => sanitize(e, e.dataTransfer));
    input.addEventListener('keyup', e => (e.keyCode == 13 && search()));
    input.addEventListener('beforeinput', (e) => {
      if (
        (e.data != null && !/([0-9a-zA-Z-_ ]+)/g.test(e.data))
        || e.inputType == 'insertLineBreak' || e.inputType == 'insertParagraph'
      )
        e.preventDefault();
    });
  }
}; search.init();

function addResultTree(query, id, results, ulRootElement) {
  if (typeof results !== 'object')
    return false;

  if (document.getElementById(id)) {
    removeResultTree(query);
    return addResultTree(query, results, ulRootElement);
  }

  // create new li element for ulRootElement
  const li = document.createElement('li');
  li.classList.add('search-result');
  window.requestAnimationFrame(() => li.classList.add('show'));

  // set resultID to list element
  li.id = id;

  const span = document.createElement('span');
  span.classList.add('arrow', 'down');
  span.textContent = `results for '${query}':`;

  li.append(span);

  // create button to destroy the tree
  const button = document.createElement('button');
  button.textContent = 'drop';
  button.addEventListener('click', function () {
    const _p = this.parentElement;
    // destroy parent when opacity transition ends
    _p.classList.remove('show');
    _p.addEventListener('transitionend', e => {
      if (e.propertyName == 'opacity')
        _p.remove();
    });
  });
  li.append(button);

  // Create unordered list
  const ul = document.createElement('ul');
  ul.classList.toggle('nested');
  for (const result of results) {
    // create & append an item to list for each result
    ul.append(createResultListItem(result.id, result.details));
  }
  li.append(ul);

  // append the new list item to the begining of the list
  ulRootElement.prepend(li);

  // set scrollHeight instead of auto, add event to toggle
  ul.style.height = `${ul.scrollHeight}px`;

  span.addEventListener('click', function () {
    const _ul = this.parentElement.getElementsByTagName('ul')[0];

    _ul.style.height = this.classList.toggle('down')
      ? `${_ul.scrollHeight}px`
      : 0;
  });
}

function createResultListItem(id, details) {
  const li = document.createElement('li');
  li.classList.add('result');
  li.id = id;
  li.details = details; // store all details for later

  const title = document.createElement('div');
  title.classList.add('title');
  const info = document.createElement('div');
  info.classList.add('info');

  title.textContent = details.title;
  info.textContent = `${details.type}, ${details.year}`;
  li.append(title, info);

  li.addEventListener('click', e => ExtractDialog.show(e));

  return li;
}

function removeResultTree(query) {
  const resultID = 'searchResult-' + query;
  const eQuery = document.getElementById(resultID);
  if (eQuery)
    eQuery.remove();
  else
    console.log(`element id '${resultID}' not found`);
}