'use strict';

/**
 * Recurso "análise" (identificar momentos interessantes). Ponto de entrada do núcleo; a documentação
 * (sinais, critérios provisórios, limites) está em docs/recursos/analysis.md.
 */
const { AnalysisError } = require('./errors');
const { analyzeSource } = require('./analyze');
const { AnalysisManager } = require('./manager');
const params = require('./params');
const { AnalysisCache, sourceKey } = require('./cache');

module.exports = { AnalysisError, analyzeSource, AnalysisManager, AnalysisCache, sourceKey, ...params };
