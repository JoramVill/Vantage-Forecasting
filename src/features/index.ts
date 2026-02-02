// Feature engineering module - transforms merged data into ML-ready features
export {
  calculateRelativeHumidity,
  calculateHeatIndex,
  buildFeatureVector,
  buildTrainingSamples,
  featureVectorToArray,
  getFeatureNames,
  extractZonalFeatures
} from './featureEngineering.js';
