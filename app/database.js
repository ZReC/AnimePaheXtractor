const { Database: DriverDatabase } = require('sqlite3');
const sqlite = require('sqlite');
const { promises: fs, constants: fs_consts } = require('fs');

class Database {
  /** @type {Database[]} */
  static siblings = [];

  /**
   * @param {string} name
   * @returns {Promise<Database|Error>}
   */
  static async open(name) {
    try {
      if (await fs.access('data', fs_consts.F_OK).catch(() => true))
        await fs.mkdir('data');

      if (Database.siblings[name] == undefined)
        this.siblings[name] = new Database(await sqlite.open({ filename: `data/${name}.db3`, driver: DriverDatabase }));
      return this.siblings[name];
    } catch (err) { return err; }
  }

  /**
   * @param {string} name 
   * @returns {boolean}
   */
  static close(name) {
    if (this.siblings[name] instanceof Database) {
      this.siblings[name].close();
      delete this.siblings[name];
    } else
      return false;

    return true;
  }

  static TYPE = Object.freeze({
    TEXT: 0,
    NUMERIC: 1,
    INTEGER: 2,
    REAL: 3,
    BLOB: 4
  });

  constructor(db) {
    /** @type {sqlite.Database} */
    this.db = db;
  }

  close() {
    this.db.close();
  }

  getType(num) {
    switch (num) {
      case 0:
        return 'TEXT';
      case 1:
        return 'NUMERIC';
      case 2:
        return 'INTEGER';
      case 3:
        return 'REAL';
      case 4:
        return 'BLOB';
      default:
        throw new Error('invalid type');
    }
  }

  createTable(name, ...args) {
    let query = `CREATE TABLE IF NOT EXISTS ${name}(`;
    args.forEach(v => {
      query += `${v[0]} ${this.getType(v[1])},`;
    });
    query += `PRIMARY KEY (${args[0][0]})) WITHOUT ROWID`;

    return this.db.run(query);
  }

  select(from, cols, where, all = false) {
    let query = `SELECT `;
    query += cols
      ? cols instanceof Array
        ? cols.join(',')
        : cols
      : '*';
    query += ` FROM ${from}`;

    if (where)
      query += ` WHERE ${where}`;

    return this.db[(all ? 'all' : 'get')](query);
  };

  insert(name, ...args) {
    let query = `INSERT INTO ${name}(`;
    let [cols, values] = args.reduce((p, c) => {
      p[0] += `,${c[0]}`;
      p[1].push(c[1]);
      return p;
    }, ['', []]);
    query += `${cols.slice(1)}) VALUES (${values.reduce(p => `${p},?`, '').slice(1)})`;
    return this.db.run(query, ...values);
  };

  update(name, where, ...args) {
    let query = `UPDATE ${name} `;
    let [cols, values] = args.reduce((p, c) => {
      p[0] += `,${c[0]} = ?`;
      p[1].push(c[1]);
      return p;
    }, ['', []]);
    query += `SET ${cols.slice(1)} WHERE ${where}`;
    return this.db.run(query, ...values);
  }
}

module.exports.Database = Database;