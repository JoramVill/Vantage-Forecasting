---
Status: Done
Created: 2026-03-21
Last-Updated: 2026-03-22
Updated-By: codebase-documenter
---

# Models Page Redesign: Trained Instances Registry

## Overview

Redesign the Models page as a "Trained Instances Registry" to align with CLI and backend manual forecast logic. The layout is a split-view (Master-Detail) with comprehensive evaluation metrics and scheduler integration.

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  TRAINED INSTANCES REGISTRY                                    [Refresh] [Import]│
├──────────────────────┬──────────────────────────────────────────────────────┤
│ ┌──────────────────┐ │  ┌─────────────────────────────────────────────────┐ │
│ │ 🔍 Search...     │ │  │ ZONAL DEMAND MODEL                              │ │
│ └──────────────────┘ │  │ Trained: 2026-03-21 14:30                       │ │
│                      │  │ Status: ● Active (Scheduler)                    │ │
│ Filter: [All ▼]      │  └─────────────────────────────────────────────────┘ │
│                      │                                                      │
│ ┌──────────────────┐ │  ┌─[Configuration]──[Calibration]──[Evaluation]────┐ │
│ │ ● Zonal Demand   │ │  │                                                 │ │
│ │   Mar 21, 14:30  │ │  │  Tab content changes based on selection         │ │
│ │   14 models      │ │  │                                                 │ │
│ │   MAPE: 2.1%     │ │  │  - Configuration: hyperparameters, settings     │ │
│ ├──────────────────┤ │  │  - Calibration: pass 1/2 results, zone scales   │ │
│ │   Regional       │ │  │  - Evaluation: hierarchical MAPE breakdown      │ │
│ │   Mar 20, 09:15  │ │  │                                                 │ │
│ │   3 models       │ │  └─────────────────────────────────────────────────┘ │
│ │   MAPE: 2.8%     │ │                                                      │
│ └──────────────────┘ │  ┌─────────────────────────────────────────────────┐ │
│                      │  │ [Set as Active] [Export] [Compare] [Delete]     │ │
│                      │  └─────────────────────────────────────────────────┘ │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

---

## Phase 1: Search/Filter & Tabbed Interface

### 1.1 Left Panel Enhancements

**File:** `gui/src/App.vue`

Add to the models list panel:
- Search input field (filters by entity code, type, date)
- Filter dropdown (All, Zonal, Regional, CFAC types)
- Visual indicator for active models (green dot)

**State variables to add:**
```typescript
const modelSearchQuery = ref('');
const modelTypeFilter = ref<string>('all');
```

**Computed property:**
```typescript
const filteredInstances = computed(() => {
  return trainingInstances.value.filter(instance => {
    // Filter by type
    if (modelTypeFilter.value !== 'all' && instance.entityType !== modelTypeFilter.value) {
      return false;
    }
    // Filter by search query
    if (modelSearchQuery.value) {
      const query = modelSearchQuery.value.toLowerCase();
      return instance.entityType.toLowerCase().includes(query) ||
             instance.trainedAt.includes(query) ||
             instance.models.some(m => m.entity_code.toLowerCase().includes(query));
    }
    return true;
  });
});
```

### 1.2 Right Panel: Tabbed Interface

**Tabs:**
1. **Configuration** - Training parameters, hyperparameters
2. **Calibration** - Pass 1/2 results (already implemented)
3. **Evaluation** - Hierarchical metrics breakdown

**State:**
```typescript
const instanceDetailTab = ref<'config' | 'calibration' | 'evaluation'>('config');
```

**Tab Content Structure:**

```html
<!-- Tab Navigation -->
<div class="instance-tabs">
  <button :class="{ active: instanceDetailTab === 'config' }" @click="instanceDetailTab = 'config'">
    Configuration
  </button>
  <button :class="{ active: instanceDetailTab === 'calibration' }" @click="instanceDetailTab = 'calibration'">
    Calibration
  </button>
  <button :class="{ active: instanceDetailTab === 'evaluation' }" @click="instanceDetailTab = 'evaluation'">
    Evaluation
  </button>
</div>

<!-- Tab Content -->
<div class="instance-tab-content">
  <div v-if="instanceDetailTab === 'config'" class="config-panel">
    <!-- Configuration content -->
  </div>
  <div v-if="instanceDetailTab === 'calibration'" class="calibration-panel">
    <!-- Existing calibration content -->
  </div>
  <div v-if="instanceDetailTab === 'evaluation'" class="evaluation-panel">
    <!-- Evaluation tree -->
  </div>
</div>
```

---

## Phase 2: Hierarchical Evaluation Tree

### 2.1 Data Structure

**Add to TrainingInstance interface:**
```typescript
interface EvaluationMetrics {
  overall: {
    mape: number;
    rmse: number;
    mae: number;
    bias: number;
  };
  byEntity: {
    [entityCode: string]: {
      mape: number;
      rmse: number;
      mae: number;
      sampleCount: number;
    };
  };
  byRegion?: {
    [regionCode: string]: {
      mape: number;
      zones: string[];  // Zone codes in this region
    };
  };
}
```

### 2.2 Evaluation Tree Component

**Structure:**
```
▼ Overall Performance           MAPE: 2.1%
  ▼ LUZON (3 zones)            MAPE: 1.8%
    ├─ 01NLUZ   ████████░░     2.1%
    ├─ 02METRO  ███████░░░     1.5%
    └─ 03SLUZ   █████████░     1.9%
  ▶ VISAYAS (5 zones)          MAPE: 2.3%
  ▶ MINDANAO (6 zones)         MAPE: 2.4%
```

**State:**
```typescript
const expandedRegions = ref<Set<string>>(new Set());

function toggleRegion(region: string) {
  if (expandedRegions.value.has(region)) {
    expandedRegions.value.delete(region);
  } else {
    expandedRegions.value.add(region);
  }
}
```

### 2.3 MAPE Bar Visualization

```typescript
function getMapeBarWidth(mape: number): string {
  // Scale: 0% = 0 width, 10% = full width
  const width = Math.min(100, (mape / 10) * 100);
  return `${width}%`;
}

function getMapeBarColor(mape: number): string {
  if (mape < 2) return 'var(--success-color)';
  if (mape < 4) return 'var(--warning-color)';
  return 'var(--error-color)';
}
```

---

## Phase 3: Scheduler/Manual Integration

### 3.1 Active Model Indicator

**Database addition (modelStore.ts):**
```sql
-- Add to models table
is_scheduler_active INTEGER DEFAULT 0,
last_used_at TEXT,
usage_count INTEGER DEFAULT 0
```

**Display in list item:**
```html
<div class="instance-status">
  <span v-if="instance.isSchedulerActive" class="status-badge scheduler">
    ● Scheduler
  </span>
  <span v-if="instance.isManualActive" class="status-badge manual">
    ● Manual
  </span>
</div>
```

### 3.2 Set Active Actions

```typescript
async function setAsSchedulerActive(instanceId: string) {
  // Deactivate all other instances of same type
  // Set this instance as scheduler active
  await window.api.setSchedulerActiveModel(instanceId);
  await loadModels();
}
```

---

## Phase 4: Model Comparison (Future)

### 4.1 Comparison Selection

- Checkboxes on instance list items
- "Compare Selected" button (enabled when 2+ selected)
- Side-by-side comparison view

### 4.2 Comparison Metrics

- Delta MAPE between models
- Training period overlap
- Configuration differences highlighted

---

## File Changes Summary

| File | Changes |
|------|---------|
| `gui/src/App.vue` | Search/filter, tabs, evaluation tree, styles |
| `src/services/modelStore.ts` | Add evaluation data retrieval, integration status |
| `gui/helpers/model-store-helper.cjs` | Match modelStore changes |
| `src/types/models.ts` | EvaluationMetrics interface |

---

## CSS Styling Guidelines

### Color Scheme
- Active/success: `#10b981` (green)
- Warning: `#f59e0b` (amber)
- Error: `#ef4444` (red)
- Primary accent: `#6366f1` (indigo)

### Component Patterns
- Tabs: Underline style, not boxed
- Tree: Indented with connection lines
- Bars: Rounded, animated on load
- Cards: Subtle shadow, rounded corners

---

## Implementation Order

1. **Phase 1A**: Add search input and filter dropdown
2. **Phase 1B**: Implement tabbed interface structure
3. **Phase 1C**: Move calibration content to Calibration tab
4. **Phase 1D**: Add Configuration tab content
5. **Phase 2A**: Create evaluation tree structure
6. **Phase 2B**: Add MAPE bar visualizations
7. **Phase 2C**: Implement collapsible regions
8. **Phase 3A**: Add active model indicators
9. **Phase 3B**: Implement "Set as Active" functionality

---

## Validation Checklist

- [ ] Search filters instances correctly
- [ ] Type filter works for all entity types
- [ ] Tabs switch content correctly
- [ ] Calibration data displays in Calibration tab
- [ ] Configuration shows training parameters
- [ ] Evaluation tree expands/collapses
- [ ] MAPE bars scale correctly
- [ ] Active indicators show correctly
- [ ] Set Active updates the scheduler
- [ ] Responsive layout works at different widths
