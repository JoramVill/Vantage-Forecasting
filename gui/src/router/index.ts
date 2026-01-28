import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from '../views/ChatView.vue'
import TrainView from '../views/TrainView.vue'
import ForecastView from '../views/ForecastView.vue'
import EvaluateView from '../views/EvaluateView.vue'
import SchedulerView from '../views/SchedulerView.vue'
import SettingsView from '../views/SettingsView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/chat'
    },
    {
      path: '/chat',
      name: 'chat',
      component: ChatView
    },
    {
      path: '/train',
      name: 'train',
      component: TrainView
    },
    {
      path: '/forecast',
      name: 'forecast',
      component: ForecastView
    },
    {
      path: '/evaluate',
      name: 'evaluate',
      component: EvaluateView
    },
    {
      path: '/scheduler',
      name: 'scheduler',
      component: SchedulerView
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView
    }
  ]
})

export default router
