/** Reviewed regex literals added by the canonical final-video lifecycle schemas. */
export const PATH_FREE_OPAQUE_TEXT_SCHEMA_PATTERN = "^(?![~/\\\\])(?![A-Za-z]:)(?![hH][tT][tT][pP][sS]?:|[fF][iI][lL][eE]:|[dD][aA][tT][aA]:|[bB][lL][oO][bB]:)(?!.*[\\\\/])(?!.*(?:[aA][pP][iI][_-]?[kK][eE][yY]|[sS][eE][cC][rR][eE][tT]|[pP][aA][sS][sS][wW][oO][rR][dD]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL]|[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|[bB][eE][aA][rR][eE][rR]|[cC][oO][oO][kK][iI][eE]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY]))[^\\u0000-\\u001F\\u007F]+$";
export const SECRET_FREE_SCHEMA_ID_PATTERN = "^(?!.*(?:[aA][pP][iI][_-]?[kK][eE][yY]|[sS][eE][cC][rR][eE][tT]|[pP][aA][sS][sS][wW][oO][rR][dD]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL]|[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|[bB][eE][aA][rR][eE][rR]|[cC][oO][oO][kK][iI][eE]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY])).+$";

export const LIFECYCLE_V1_PUBLISHED_SCHEMA_PATTERNS = [
  ["^[^\\u0000-\\u001F\\u007F]+$", /^[^\u0000-\u001F\u007F]+$/],
  ["^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$", /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/],
  ["^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/],
  ["^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/],
  ["^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/],
  ["^[A-Za-z0-9._:-]+$", /^[A-Za-z0-9._:-]+$/],
  ["^[a-z][a-z0-9-]{0,63}$", /^[a-z][a-z0-9-]{0,63}$/],
  ["^[a-z][a-z0-9.-]{0,63}/[a-z][a-z0-9._-]{0,95}@\\d{1,8}$", /^[a-z][a-z0-9.-]{0,63}\/[a-z][a-z0-9._-]{0,95}@\d{1,8}$/],
  [PATH_FREE_OPAQUE_TEXT_SCHEMA_PATTERN, /^(?![~/\\])(?![A-Za-z]:)(?![hH][tT][tT][pP][sS]?:|[fF][iI][lL][eE]:|[dD][aA][tT][aA]:|[bB][lL][oO][bB]:)(?!.*[\\/])(?!.*(?:[aA][pP][iI][_-]?[kK][eE][yY]|[sS][eE][cC][rR][eE][tT]|[pP][aA][sS][sS][wW][oO][rR][dD]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL]|[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|[bB][eE][aA][rR][eE][rR]|[cC][oO][oO][kK][iI][eE]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY]))[^\u0000-\u001F\u007F]+$/],
  [SECRET_FREE_SCHEMA_ID_PATTERN, /^(?!.*(?:[aA][pP][iI][_-]?[kK][eE][yY]|[sS][eE][cC][rR][eE][tT]|[pP][aA][sS][sS][wW][oO][rR][dD]|[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL]|[aA][uU][tT][hH][oO][rR][iI][zZ][aA][tT][iI][oO][nN]|[bB][eE][aA][rR][eE][rR]|[cC][oO][oO][kK][iI][eE]|[pP][rR][iI][vV][aA][tT][eE][_-]?[kK][eE][yY])).+$/]
] as const;
