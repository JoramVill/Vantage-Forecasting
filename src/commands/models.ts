/**
 * Model Management CLI Commands
 *
 * Commands for managing trained forecast models.
 */

import { Command } from 'commander';
import {
  initializeModelStore,
  listModels,
  getModelById,
  getModelRegistryById,
  activateModel,
  archiveModel,
  deleteModel,
  listModelGroups,
  listTrainingRuns,
  exportModel,
  importModel,
  getTrainingInstances,
} from '../services/modelStore.js';
import { trainDemandModels, trainCFACModels } from '../services/modelTrainer.js';
import { ModelRegistry } from '../types/models.js';

/**
 * Create models command
 */
export function createModelsCommand(): Command {
  const command = new Command('models');
  command.description('Manage trained forecast models');

  // models init
  command
    .command('init')
    .description('Initialize model store (database + directory structure)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        initializeModelStore();
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model store initialized successfully' }));
        } else {
          console.log('✓ Model store initialized successfully');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error initializing model store:', error.message);
        }
        process.exit(1);
      }
    });

  // models train
  command
    .command('train')
    .description('Train demand or CFAC models')
    .requiredOption('-t, --type <type>', 'Entity type: regional, zonal, cfac')
    .option('-d, --demand <path>', 'Demand training data path (for demand models)')
    .option('-c, --cfac <path>', 'CFAC training data path (for CFAC models)')
    .option('-s, --start <date>', 'Training period start date (YYYY-MM-DD)')
    .option('-e, --end <date>', 'Training period end date (YYYY-MM-DD)')
    .option('-w, --weather <files...>', 'Manual weather CSV files')
    .option('--model <type>', 'Model type: xgboost, hybrid, regression (demand) or 4tier, hybrid (cfac)', 'hybrid')
    .option('--stations <codes...>', 'Station codes to train (CFAC only)')
    .option('--group <name>', 'Group model name (e.g., all_wind, all_solar)')
    .option('--holdout-days <n>', 'Days to hold out for testing', '14')
    .option('--no-auto-activate', 'Do not auto-activate if better than current')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const holdoutDays = parseInt(options.holdoutDays, 10);

        if (!['regional', 'zonal', 'cfac'].includes(options.type)) {
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: 'Invalid type. Must be: regional, zonal, or cfac' }));
          } else {
            console.error('Invalid type. Must be: regional, zonal, or cfac');
          }
          process.exit(1);
        }

        let results;

        // Route to appropriate trainer based on type
        if (options.type === 'cfac') {
          // CFAC training
          if (!options.cfac) {
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: 'CFAC training data path required (--cfac)' }));
            } else {
              console.error('CFAC training data path required (--cfac)');
            }
            process.exit(1);
          }

          const validCfacModels = ['4tier', 'hybrid', 'mrec'];
          if (!validCfacModels.includes(options.model)) {
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: 'Invalid CFAC model type. Must be: 4tier, hybrid, or mrec' }));
            } else {
              console.error('Invalid CFAC model type. Must be: 4tier, hybrid, or mrec');
            }
            process.exit(1);
          }

          results = await trainCFACModels({
            trainingDataPath: options.cfac,
            startDate: options.start,
            endDate: options.end,
            modelType: options.model,
            stationCodes: options.stations,
            groupModel: options.group,
            holdoutDays,
            autoActivate: options.autoActivate !== false,
          });
        } else {
          // Demand training
          if (!options.demand) {
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: 'Demand training data path required (--demand)' }));
            } else {
              console.error('Demand training data path required (--demand)');
            }
            process.exit(1);
          }

          const zonal = options.type === 'zonal';
          const validDemandModels = ['xgboost', 'hybrid', 'regression'];
          if (!validDemandModels.includes(options.model)) {
            if (options.json) {
              console.log(JSON.stringify({ success: false, error: 'Invalid demand model type. Must be: xgboost, hybrid, or regression' }));
            } else {
              console.error('Invalid demand model type. Must be: xgboost, hybrid, or regression');
            }
            process.exit(1);
          }

          results = await trainDemandModels({
            demandDataPath: options.demand,
            weatherFiles: options.weather,
            startDate: options.start,
            endDate: options.end,
            modelType: options.model,
            zonal,
            holdoutDays,
            autoActivate: options.autoActivate !== false,
          });
        }

        if (options.json) {
          const successful = results.filter(r => r.success);
          const failed = results.filter(r => !r.success);
          console.log(JSON.stringify({
            success: true,
            summary: {
              total: results.length,
              successful: successful.length,
              failed: failed.length,
            },
            results,
          }));
          return;
        }

        // Print summary
        console.log('\n=== Training Summary ===');
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        console.log(`\nSuccessful: ${successful.length}/${results.length}`);
        if (successful.length > 0) {
          console.log('\nTrained models:');
          for (const result of successful) {
            console.log(`  ${result.entityCode}: MAPE ${result.metrics?.mape.toFixed(2)}% ${result.activated ? '[ACTIVATED]' : ''}`);
          }
        }

        if (failed.length > 0) {
          console.log(`\nFailed: ${failed.length}`);
          for (const result of failed) {
            console.log(`  ${result.entityCode}: ${result.error}`);
          }
        }

      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error during training:', error.message);
        }
        process.exit(1);
      }
    });

  // models list
  command
    .command('list')
    .description('List all models')
    .option('--entity-type <type>', 'Filter by entity type (regional, zonal, wind, solar, etc.)')
    .option('--entity-code <code>', 'Filter by entity code (CLUZ, 01NLUZ, 01BURGOS, etc.)')
    .option('--active-only', 'Show only active models')
    .option('--archived-only', 'Show only archived models')
    .option('--model-type <type>', 'Filter by model type (xgboost, hybrid, etc.)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const filters: any = {};

        if (options.entityType) filters.entityType = options.entityType;
        if (options.entityCode) filters.entityCode = options.entityCode;
        if (options.activeOnly) filters.isActive = true;
        if (options.archivedOnly) filters.isArchived = true;
        if (options.modelType) filters.modelType = options.modelType;

        const models = listModels(filters);

        if (options.json) {
          console.log(JSON.stringify({ success: true, models }));
          return;
        }

        if (models.length === 0) {
          console.log('No models found');
          return;
        }

        console.log(`Found ${models.length} model(s):\n`);

        // Group by entity
        const grouped = groupByEntity(models);

        for (const [entity, entityModels] of Object.entries(grouped)) {
          console.log(`${entity}:`);

          for (const model of entityModels) {
            const active = model.is_active ? '●' : '○';
            const archived = model.is_archived ? '[ARCHIVED]' : '';
            const mape = model.mape ? `MAPE: ${model.mape.toFixed(2)}%` : 'MAPE: N/A';

            console.log(
              `  ${active} v${model.version} - ${model.model_type} - ${mape} ${archived}`
            );
            console.log(`    ID: ${model.id}`);
            console.log(`    Trained: ${model.trained_at}`);

            if (model.training_start && model.training_end) {
              console.log(`    Period: ${model.training_start} to ${model.training_end}`);
            }

            console.log('');
          }
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error listing models:', error.message);
        }
        process.exit(1);
      }
    });

  // models instances - list training instances (grouped models)
  command
    .command('instances')
    .description('List training instances (models grouped by training session)')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const instances = getTrainingInstances();

        if (options.json) {
          console.log(JSON.stringify({ success: true, instances }));
          return;
        }

        if (instances.length === 0) {
          console.log('No training instances found.');
          console.log('\nTrain models using: node dist/index.js forecast --zonal ...');
          return;
        }

        console.log(`\nTraining Instances (${instances.length}):\n`);

        for (const instance of instances) {
          const date = new Date(instance.trainedAt);
          const dateStr = date.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          });

          const typeLabel = instance.entityType === 'zonal' ? 'Zonal Demand'
            : instance.entityType === 'regional' ? 'Regional Demand'
            : instance.entityType === 'wind' ? 'Wind CFAC'
            : instance.entityType === 'solar' ? 'Solar CFAC'
            : instance.entityType;

          const avgMape = instance.avgMape != null ? instance.avgMape.toFixed(1) + '%' : 'N/A';
          const activeStr = instance.activeCount > 0 ? `${instance.activeCount} active` : '';

          console.log(`${typeLabel} - ${dateStr}`);
          console.log(`  Models: ${instance.modelCount} entities  |  Avg MAPE: ${avgMape}  ${activeStr}`);

          if (instance.trainingPeriod) {
            console.log(`  Training: ${instance.trainingPeriod.start} to ${instance.trainingPeriod.end}`);
          }

          console.log(`  ID: ${instance.id}`);
          console.log('');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error listing instances:', error.message);
        }
        process.exit(1);
      }
    });

  // models info
  command
    .command('info <id>')
    .description('Show detailed information about a model')
    .option('--json', 'Output as JSON')
    .action((id: string, options) => {
      try {
        const model = getModelById(id);
        const registry = getModelRegistryById(id);

        if (!model || !registry) {
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: `Model not found: ${id}` }));
          } else {
            console.error(`Model not found: ${id}`);
          }
          process.exit(1);
        }

        if (options.json) {
          // Return full model data for GUI
          console.log(JSON.stringify({
            success: true,
            model: {
              id: model.metadata.id,
              entityType: model.metadata.entityType,
              entityCode: model.metadata.entityCode,
              modelType: model.metadata.modelType,
              version: model.metadata.version,
              isGroupModel: model.metadata.isGroupModel,
              isActive: registry.is_active === 1,
              isArchived: registry.is_archived === 1,
              trainedAt: model.metadata.trainedAt,
              trainingPeriod: model.metadata.trainingPeriod,
              trainingRecords: model.metadata.trainingRecords,
              holdoutDays: model.metadata.holdoutDays,
              metrics: model.metrics,
              featureCount: model.featureConfig.features.length,
              features: model.featureConfig.features,
            }
          }));
          return;
        }

        console.log('Model Information\n');
        console.log('Metadata:');
        console.log(`  ID: ${model.metadata.id}`);
        console.log(`  Entity: ${model.metadata.entityType}/${model.metadata.entityCode}`);
        console.log(`  Type: ${model.metadata.modelType}`);
        console.log(`  Version: ${model.metadata.version}`);
        console.log(`  Group Model: ${model.metadata.isGroupModel ? 'Yes' : 'No'}`);
        console.log(`  Trained: ${model.metadata.trainedAt}`);

        console.log('\nTraining:');
        console.log(`  Period: ${model.metadata.trainingPeriod.start} to ${model.metadata.trainingPeriod.end}`);
        console.log(`  Records: ${model.metadata.trainingRecords}`);
        console.log(`  Holdout Days: ${model.metadata.holdoutDays}`);

        console.log('\nMetrics:');
        console.log(`  MAPE: ${model.metrics.mape.toFixed(2)}%`);
        console.log(`  RMSE: ${model.metrics.rmse.toFixed(2)}`);
        console.log(`  MAE: ${model.metrics.mae.toFixed(2)}`);
        console.log(`  R²: ${model.metrics.r2Score.toFixed(4)}`);
        console.log(`  Bias: ${model.metrics.bias.toFixed(2)}`);

        if (model.metrics.peakMape !== undefined) {
          console.log(`  Peak MAPE: ${model.metrics.peakMape.toFixed(2)}%`);
        }

        if (model.metrics.offpeakMape !== undefined) {
          console.log(`  Off-peak MAPE: ${model.metrics.offpeakMape.toFixed(2)}%`);
        }

        console.log('\nFeatures:');
        console.log(`  Count: ${model.featureConfig.features.length}`);
        console.log(`  Features: ${model.featureConfig.features.slice(0, 10).join(', ')}${model.featureConfig.features.length > 10 ? '...' : ''}`);

        console.log('\nModel Data:');
        console.log(`  Type: ${model.modelData.type}`);
        console.log(`  Size: ${JSON.stringify(model.modelData.data).length} bytes (JSON)`);

      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error getting model info:', error.message);
        }
        process.exit(1);
      }
    });

  // models activate
  command
    .command('activate <id>')
    .description('Activate a model (deactivates others for same entity)')
    .option('--json', 'Output as JSON')
    .action((id: string, options) => {
      try {
        activateModel(id);
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model activated successfully' }));
        } else {
          console.log('✓ Model activated successfully');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error activating model:', error.message);
        }
        process.exit(1);
      }
    });

  // models archive
  command
    .command('archive <id>')
    .description('Archive a model (deactivates and marks as archived)')
    .option('--json', 'Output as JSON')
    .action((id: string, options) => {
      try {
        archiveModel(id);
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model archived successfully' }));
        } else {
          console.log('✓ Model archived successfully');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error archiving model:', error.message);
        }
        process.exit(1);
      }
    });

  // models delete
  command
    .command('delete <id>')
    .description('Delete a model (removes from registry and deletes file)')
    .option('--force', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .action((id: string, options) => {
      try {
        const model = getModelById(id);

        if (!model) {
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: `Model not found: ${id}` }));
          } else {
            console.error(`Model not found: ${id}`);
          }
          process.exit(1);
        }

        // For JSON mode, always require --force (GUI handles confirmation)
        if (!options.json) {
          console.log(`About to delete model:`);
          console.log(`  Entity: ${model.metadata.entityType}/${model.metadata.entityCode}`);
          console.log(`  Version: ${model.metadata.version}`);
          console.log(`  Type: ${model.metadata.modelType}`);

          if (!options.force) {
            console.log('\nUse --force to confirm deletion');
            process.exit(1);
          }
        }

        deleteModel(id);
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model deleted successfully' }));
        } else {
          console.log('✓ Model deleted successfully');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error deleting model:', error.message);
        }
        process.exit(1);
      }
    });

  // models groups
  command
    .command('groups')
    .description('List model groups')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const groups = listModelGroups();

        if (options.json) {
          console.log(JSON.stringify({ success: true, groups }));
          return;
        }

        if (groups.length === 0) {
          console.log('No model groups defined');
          return;
        }

        console.log(`Found ${groups.length} model group(s):\n`);

        for (const group of groups) {
          console.log(`${group.group_code} (${group.group_type})`);

          if (group.description) {
            console.log(`  Description: ${group.description}`);
          }

          if (group.station_codes) {
            const stations = JSON.parse(group.station_codes);
            console.log(`  Stations: ${stations.join(', ')}`);
          }

          console.log(`  Created: ${group.created_at}`);
          console.log('');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error listing model groups:', error.message);
        }
        process.exit(1);
      }
    });

  // models runs
  command
    .command('runs')
    .description('List recent training runs')
    .option('--limit <n>', 'Number of runs to show', '20')
    .option('--json', 'Output as JSON')
    .action((options) => {
      try {
        const limit = parseInt(options.limit, 10);
        const runs = listTrainingRuns(limit);

        if (options.json) {
          console.log(JSON.stringify({ success: true, runs }));
          return;
        }

        if (runs.length === 0) {
          console.log('No training runs found');
          return;
        }

        console.log(`Recent ${runs.length} training run(s):\n`);

        for (const run of runs) {
          const status = run.status === 'completed' ? '✓' : run.status === 'failed' ? '✗' : '⋯';
          console.log(`${status} ${run.started_at} - ${run.status.toUpperCase()}`);
          console.log(`  ID: ${run.id}`);

          if (run.completed_at) {
            console.log(`  Completed: ${run.completed_at}`);
          }

          if (run.entities_trained) {
            console.log(`  Entities trained: ${run.entities_trained}`);
          }

          if (run.models_improved) {
            console.log(`  Models improved: ${run.models_improved}`);
          }

          if (run.models_activated) {
            console.log(`  Models activated: ${run.models_activated}`);
          }

          if (run.error_message) {
            console.log(`  Error: ${run.error_message}`);
          }

          console.log('');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error listing training runs:', error.message);
        }
        process.exit(1);
      }
    });

  // models evaluate
  command
    .command('evaluate <id>')
    .description('Re-evaluate a model against latest data')
    .option('--days <n>', 'Days of recent data to use for evaluation', '14')
    .option('--update', 'Update stored metrics with new evaluation results')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options) => {
      try {
        const model = getModelById(id);
        if (!model) {
          if (options.json) {
            console.log(JSON.stringify({ success: false, error: `Model not found: ${id}` }));
          } else {
            console.error(`Model not found: ${id}`);
          }
          process.exit(1);
        }

        // TODO: Implement re-evaluation logic
        // For now, return a placeholder response
        const days = parseInt(options.days, 10);

        if (options.json) {
          console.log(JSON.stringify({
            success: true,
            message: 'Model re-evaluation not yet implemented',
            modelId: id,
            evaluationDays: days,
            previousMetrics: model.metrics
          }));
        } else {
          console.log(`Re-evaluating model ${id} against last ${days} days of data...`);
          console.log('\nPrevious Metrics:');
          console.log(`  MAPE: ${model.metrics.mape.toFixed(2)}%`);
          console.log(`  RMSE: ${model.metrics.rmse.toFixed(2)}`);
          console.log(`  MAE: ${model.metrics.mae.toFixed(2)}`);
          console.log(`  R²: ${model.metrics.r2Score.toFixed(4)}`);
          console.log('\nNote: Full re-evaluation logic not yet implemented.');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error evaluating model:', error.message);
        }
        process.exit(1);
      }
    });

  // models export
  command
    .command('export <id>')
    .description('Export a model to a .vfm file')
    .requiredOption('-o, --output <path>', 'Output file path')
    .option('--json', 'Output as JSON')
    .action((id: string, options) => {
      try {
        exportModel(id, options.output);
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model exported successfully', path: options.output }));
        } else {
          console.log('✓ Model exported successfully');
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error exporting model:', error.message);
        }
        process.exit(1);
      }
    });

  // models import
  command
    .command('import <path>')
    .description('Import a model from a .vfm file')
    .option('--json', 'Output as JSON')
    .action((filePath: string, options) => {
      try {
        const newId = importModel(filePath);
        if (options.json) {
          console.log(JSON.stringify({ success: true, message: 'Model imported successfully', id: newId }));
        } else {
          console.log('✓ Model imported successfully');
          console.log(`  New ID: ${newId}`);
        }
      } catch (error: any) {
        if (options.json) {
          console.log(JSON.stringify({ success: false, error: error.message }));
        } else {
          console.error('Error importing model:', error.message);
        }
        process.exit(1);
      }
    });

  return command;
}

/**
 * Group models by entity
 */
function groupByEntity(models: ModelRegistry[]): Record<string, ModelRegistry[]> {
  const grouped: Record<string, ModelRegistry[]> = {};

  for (const model of models) {
    const key = `${model.entity_type}/${model.entity_code}`;

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(model);
  }

  return grouped;
}
