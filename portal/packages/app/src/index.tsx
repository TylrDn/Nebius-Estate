import '@backstage/cli/asset-types';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@backstage/ui/css/styles.css';
// Nebius Estate design tokens and components (side-effect import; libraries are tree-shaken).
import '@internal/backstage-plugin-nebius-estate/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(App.createRoot());
