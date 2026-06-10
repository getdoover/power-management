import {defineConfig} from '@rsbuild/core';
import {pluginReact} from '@rsbuild/plugin-react';
import {createModuleFederationConfig, pluginModuleFederation} from '@module-federation/rsbuild-plugin';
import ConcatenatePlugin from './ConcatenatePlugin.ts';

const mfConfig = createModuleFederationConfig({
    name: 'SolarPowerDashboardWidget',
    remotes: {
        // The actual URLs are injected by the host at runtime
        // (window.dooverAdminSite_remoteUrl / window.dooverCustomerSite_remoteUrl).
        doover_admin: 'doover_admin@[window.dooverAdminSite_remoteUrl]',
        customer_site: 'customer_site@[window.dooverCustomerSite_remoteUrl]',
    },
    exposes: {
        './SolarPowerDashboardWidget': './src/SolarPowerDashboardWidget',
    },
    shared: {
        react: {singleton: true, requiredVersion: '^18.3.1', eager: true},
        'react-dom': {singleton: true, requiredVersion: '^18.3.1', eager: true},
        'react-router': {singleton: true, requiredVersion: false, eager: true},
        // Share doover-js (and its react entrypoint) so the widget uses the
        // host's DooverClient instance — same WebSocket, same query cache.
        'doover-js': {singleton: true, eager: true, requiredVersion: false},
        'doover-js/react': {singleton: true, eager: true, requiredVersion: false},
        '@tanstack/react-query': {singleton: true, eager: true, requiredVersion: false},
    },
});

export default defineConfig({
    tools: {
        rspack: {
            plugins: [
                new ConcatenatePlugin({
                    source: './dist',
                    destination: './assets',
                    name: 'SolarPowerDashboardWidget.js',
                    ignore: ['main.js'],
                }),
            ],
        },
    },
    output: {
        injectStyles: true,
    },
    plugins: [
        pluginReact(),
        pluginModuleFederation(mfConfig),
    ],
    performance: {
        chunkSplit: {
            strategy: 'all-in-one',
        },
    },
});
