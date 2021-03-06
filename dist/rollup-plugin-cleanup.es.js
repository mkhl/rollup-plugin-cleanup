/**
 * rollup-plugin-cleanup v2.0.0
 * @author aMarCruz
 * @license MIT
 */
import { createFilter } from 'rollup-pluginutils';
import { extname } from 'path';
import MagicString from 'magic-string';
import acorn from 'acorn';

/**
 * Creates a filter for the options `include`, `exclude`, and `extensions`.
 * Since `extensions` is not a rollup option, I think is widely used.
 *
 * @param {object} opts? - The user options
 * @returns {function}     Filter function that returns true if a given
 *                         file matches the filter.
 */
function _createFilter(opts) {

  const filt = createFilter(opts.include, opts.exclude);

  let exts = opts.extensions || ['.js', '.jsx', '.tag'];
  if (!Array.isArray(exts)) { exts = [exts]; }
  for (let i = 0; i < exts.length; i++) {
    const e = exts[i];
    if (e === '*') {
      exts = '*';
      break
    } else if (e[0] !== '.') {
      exts[i] = '.' + e;
    }
  }

  return function (name) {
    return filt(name) && (exts === '*' || exts.indexOf(extname(name)) > -1)
  }
}

/* eslint no-useless-escape:0 */

const _filters = {
  // only preserve license
  license:  /@license\b/,
  // (almost) like the uglify defaults
  some:     /(?:@license|@preserve|@cc_on)\b/,
  // http://usejsdoc.org/
  jsdoc:    /^\*\*[^@]*@[A-Za-z]/,
  // http://www.jslint.com/help.html
  jslint:   /^[/\*](?:jslint|global|property)\b/,
  // http://jshint.com/docs/#inline-configuration
  jshint:   /^[/\*]\s*(?:jshint|globals|exported)\s/,
  // http://eslint.org/docs/user-guide/configuring
  eslint:   /^[/\*]\s*(?:eslint(?:\s|-env|-disable|-enable)|global\s)/,
  // https://palantir.github.io/tslint/usage/rule-flags/
  ts3s:     /^\/\/[ \t]*<(?:reference\s|amd-).*>/,
  // http://jscs.info/overview
  jscs:     /^[/\*]\s*jscs:[ed]/,
  // https://gotwarlost.github.io/istanbul/
  istanbul: /^[/\*]\s*istanbul\s/,
  // http://www.html5rocks.com/en/tutorials/developertools/sourcemaps/
  srcmaps:  /^.[#@]\ssource(?:Mapping)?URL=/
};

function parseOptions(options) {

  // multiple forms to specify comment filters, default is 'some'
  let comments = options.comments;
  if (comments == null) {
    comments = [_filters.some];
  } else if (typeof comments != 'boolean') {
    const filters = Array.isArray(comments) ? comments : [comments];
    comments = [];
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      if (f instanceof RegExp) {
        comments.push(f);
      } else if (f === 'all') {
        comments = true;
        break
      } else if (f === 'none') {
        comments = false;
        break
      } else if (f in _filters) {
        comments.push(_filters[f]);
      } else {
        throw new Error(`cleanup: unknown comment filter: "${f}"`)
      }
    }
  }

  let normalizeEols = options.hasOwnProperty('normalizeEols')
    ? options.normalizeEols : options.eolType;
  if (normalizeEols !== false && normalizeEols !== 'win' && normalizeEols !== 'mac') {
    normalizeEols = 'unix';
  }

  return {
    ecmaVersion: options.ecmaVersion || 8,
    sourceMap: options.sourceMap !== false && options.sourcemap !== false,
    sourceType: options.sourceType || 'module',
    maxEmptyLines: options.maxEmptyLines | 0,
    normalizeEols,
    comments
  }
}

/**
 * By using a premaked block of spaces, blankBlock is faster than
 * simple block.replace(/[^ \n]+/, ' ').
 *
 * @const {string}
 * @private
 */
const _spaces = new Array(150).join(' ');

/**
 * Matches non-EOL characteres.
 * @const
 * @private
 */
const NOBLANK = /[^\n\r]+/g;

/**
 * Replaces all the non-EOL characters in the block with spaces.
 *
 * @param   {string} block - The buffer to replace
 * @returns {string}         The replaced block.
 * @private
 */
function blankBlock(block) {
  const len = block.length;

  let spaces = _spaces;
  while (spaces.length < len) {
    spaces += _spaces;
  }

  return spaces.slice(0, len)
}

/**
 * Replaces the comments with spaces.
 *
 * @param {string} code - JS code
 * @param {string} file - Name of the file being processed
 * @param {object} options - User options
 * @prop {boolean|RegExp[]} options.comments - Comment filters
 * @returns {string} The processed code
 */
function blankComments(code, file, options) {
  const comments = options.comments;

  const onComment = function (block, text, start, end) {
    if (comments !== false) {
      text = (block ? '*' : '/') + text;
      for (let i = 0; i < comments.length; i++) {
        if (comments[i].test(text)) { return }
      }
    }
    text = code.slice(start, end).replace(NOBLANK, blankBlock);
    code = code.slice(0, start) + text + code.slice(end);
  };

  // Now replace the comments. As blankComment will not change code
  // positions, trimming empty lines will be easy.
  acorn.parse(code, {
    ecmaVersion: options.ecmaVersion,
    sourceType: options.sourceType,
    onComment
  });

  return code
}

const EOL_TYPES   = { unix: '\n', mac: '\r', win: '\r\n' };
const FIRST_LINES = /^(\s*[\r\n])\s*\S/;
const EACH_LINE   = /.*(?:\r\n?|\n)/g;
const TRIM_SPACES = /[^\S\r\n]+$/;

function removeLines(magicStr, code, file, options) {

  // matches one or more line endings and their leading spaces
  const NEXT_LINES = /\s*[\r\n]/g;

  const eolTo   = EOL_TYPES[options.normalizeEols];
  const empties = options.maxEmptyLines;

  let maxEolChars = empties < 0 ? Infinity : empties ? empties * eolTo.length : 0;
  let match, block;
  let changes = false;

  // Helpers
  // -------

  const replaceBlock = (str, start, rep) => {
    if (str !== rep) {
      magicStr.overwrite(start, start + str.length, rep);
      changes = true;
    }
  };

  const limitLines = (str) => {
    let ss = str.replace(EACH_LINE, eolTo);
    if (ss.length > maxEolChars) {
      ss = ss.slice(0, maxEolChars);
    }
    return ss
  };

  // Lines remotion
  // --------------

  // first empty lines
  match = code.match(FIRST_LINES);
  if (match) {
    block = match[1];
    replaceBlock(block, 0, limitLines(block));
    NEXT_LINES.lastIndex = match[0].length;
  }

  // middle lines count one more
  maxEolChars += eolTo.length;

  if (empties) {
    // maxEmptyLines -1 or > 0
    while ((match = NEXT_LINES.exec(code))) {
      block = match[0];
      replaceBlock(block, match.index, limitLines(block));
    }
  } else {
    // removes all the empty lines
    while ((match = NEXT_LINES.exec(code))) {
      replaceBlock(match[0], match.index, eolTo);
    }
  }

  // now, trim the last spaces not handled by previous regex
  match = code.match(TRIM_SPACES);
  if (match) {
    replaceBlock(match[0], match.index, '');
  }

  return changes
}

/* eslint no-debugger:0 */

function cleanup(source, file, options) {

  return new Promise(resolve => {
    let changes;
    let code;

    if (options.comments === true) {
      code = source;
    } else {
      code = blankComments(source, file, options);
      changes = code !== source;
    }

    const magicStr = new MagicString(code);

    changes = removeLines(magicStr, code, file, options) || changes;

    resolve(changes
      ? {
        code: magicStr.toString(),
        map: options.sourceMap ? magicStr.generateMap({ hires: true }) : null
      }
      : null);   // tell to Rollup that discard this result

  })

}

/**
 * Returns the rollup-plugin-cleanup instance.
 * @param   {Object} options - Plugin's user options
 * @returns {Object} Plugin instance.
 */
function rollupCleanup(options) {
  if (!options) { options = {}; }

  // merge include, exclude, and extensions
  const filter = _createFilter(options);

  // validate and clone the plugin options
  options = parseOptions(options);

  // the plugin instance
  return {

    name: 'cleanup',

    options(opts) {
      if (opts.sourceMap === false || opts.sourcemap === false) {
        options.sourceMap = false;
      }
    },

    transform(code, id) {

      if (filter(id)) {

        return cleanup(code, id, options)
          .catch(err => {
            if (typeof this.error == 'function') {
              this.error(err);
            } else {
              throw new Error(err)
            }
          })

      }

      return null
    }
  }
}

export default rollupCleanup;
