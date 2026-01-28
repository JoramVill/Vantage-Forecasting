<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="app-container">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1>iLoad</h1>
        <div class="subtitle">Forecasting Utility</div>
      </div>
      <nav class="sidebar-nav">
        <RouterLink to="/chat" class="nav-item" active-class="active">
          <span class="icon">&#128172;</span>
          AI Assistant
        </RouterLink>
        <div class="nav-divider"></div>
        <RouterLink to="/train" class="nav-item" active-class="active">
          <span class="icon">&#128200;</span>
          Train Model
        </RouterLink>
        <RouterLink to="/forecast" class="nav-item" active-class="active">
          <span class="icon">&#128302;</span>
          Generate Forecast
        </RouterLink>
        <RouterLink to="/evaluate" class="nav-item" active-class="active">
          <span class="icon">&#128202;</span>
          Evaluate
        </RouterLink>
        <RouterLink to="/scheduler" class="nav-item" active-class="active">
          <span class="icon">&#128197;</span>
          Scheduler
        </RouterLink>
        <div class="nav-divider"></div>
        <RouterLink to="/settings" class="nav-item" active-class="active">
          <span class="icon">&#9881;</span>
          Settings
        </RouterLink>
      </nav>
    </aside>
    <main class="main-content">
      <RouterView />
    </main>
  </div>
</template>

<style>
.nav-divider {
  height: 1px;
  background: rgba(255,255,255,0.1);
  margin: 8px 20px;
}
</style>
