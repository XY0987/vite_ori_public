import cloneDeep from 'lodash/cloneDeep.js'
import { message } from '@debug/message.js'

const original = {
  message,
  nested: {
    optimized: true,
  },
}
const cloned = cloneDeep(original)

document.querySelector('#app').textContent =
  `${cloned.message} lodash pre-bundling: ${cloned.nested.optimized}`
