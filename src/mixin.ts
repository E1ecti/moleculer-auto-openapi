import {
    defaultSettings,
    MoleculerOpenAPIGenerator,
    OA_GENERATE_DOCS_INPUT,
    OA_GENERATE_DOCS_OUTPUT
} from './MoleculerOpenAPIGenerator.js';
import { defaultOpenApiVersion } from './commons.js';
import { Context, Service, ServiceSchema, ServiceSettingSchema } from 'moleculer';
import fs from 'fs';
import { ECacheMode, OpenApiMixinSettings } from './types/index.js';
import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { RuleString } from 'fastest-validator';

const swaggerUiAssetPath = getAbsoluteFSPath();
type openApiService = Service<OpenApiMixinSettings> & { generator?: MoleculerOpenAPIGenerator };

export const mixin: ServiceSchema<ServiceSettingSchema> = {
    name: `openapi`,
    settings: defaultSettings as OpenApiMixinSettings,
    events: {
        async '$api.aliases.regenerated'(this: openApiService) {
            const generateDocsAction = 'generateDocs';
            const { cacheMode } = this.settings;
            if (cacheMode !== ECacheMode.TIMEOUT && this.broker.cacher && this.actions[generateDocsAction]) {
                const cacheKey = this.broker.cacher.getCacheKey(`${this.fullName}.${generateDocsAction}`, {}, {}, []);
                await this.broker.cacher.clean(`${cacheKey}*`);
            }

            if (cacheMode === ECacheMode.REFRESH) {
                await this.actions[generateDocsAction]();
            }
        }
    },
    actions: {
        generateDocs: {
            rest: {
                path: '/openapi.json',
                method: 'GET'
            },
            cache: {
                enabled(this: openApiService) {
                    return this.settings.cacheOpenApi;
                },
                keygen: (actionName: string, params: OA_GENERATE_DOCS_INPUT) => {
                    if (!params.version) {
                        return actionName;
                    }

                    return `${actionName}|${params?.version || defaultOpenApiVersion}`;
                },
                ttl: 600
            },
            openapi: {
                // you can declare custom Path Item Object
                // which override autogenerated object from params
                // https://github.com/OAI/OpenAPI-Specification/blob/b748a884fa4571ffb6dd6ed9a4d20e38e41a878c/versions/3.0.3.md#path-item-object-example
                // summary: 'OpenAPI schema url',

                // you custom response
                // https://github.com/OAI/OpenAPI-Specification/blob/b748a884fa4571ffb6dd6ed9a4d20e38e41a878c/versions/3.0.3.md#response-object-examples
                responses: {
                    '200': {
                        description: '',
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: '#/components/schemas/OpenAPIModel'
                                }
                            }
                        }
                    }
                },

                // you custom tag
                // https://github.com/OAI/OpenAPI-Specification/blob/b748a884fa4571ffb6dd6ed9a4d20e38e41a878c/versions/3.0.3.md#fixed-fields-8
                tags: ['openapi'],

                // components which attached to root of docx
                // https://github.com/OAI/OpenAPI-Specification/blob/b748a884fa4571ffb6dd6ed9a4d20e38e41a878c/versions/3.0.3.md#components-object
                components: {
                    schemas: {
                        // you custom schema
                        // https://github.com/OAI/OpenAPI-Specification/blob/b748a884fa4571ffb6dd6ed9a4d20e38e41a878c/versions/3.0.3.md#models-with-polymorphism-support
                        OpenAPIModel: {
                            type: 'object',
                            properties: {
                                openapi: {
                                    examples: ['3.0.3'],
                                    type: 'string',
                                    description: 'OpenAPI version'
                                },
                                info: {
                                    type: 'object',
                                    properties: {
                                        description: {
                                            type: 'string'
                                        }
                                    }
                                },
                                tags: {
                                    type: 'array',
                                    items: {
                                        type: 'string'
                                    }
                                }
                            },
                            required: ['openapi']
                        }
                    }
                }
            },
            // TODO support multiples OA version ?
            // params: {
            //     version: {
            //         type: 'number',
            //         default: defaultOpenApiVersion,
            //         enum: openApiVersionsSupported
            //     }
            // },
            handler(this: openApiService, ctx: Context<OA_GENERATE_DOCS_INPUT>): Promise<OA_GENERATE_DOCS_OUTPUT> {
                return this.getGenerator().generateSchema(ctx);
            }
        },
        assets: {
            rest: {
                path: '/assets/:file',
                method: 'GET'
            },
            openapi: {
                summary: 'OpenAPI assets',
                description: 'Return files from swagger-ui-dist folder'
            },
            params: {
                file: {
                    type: 'enum',
                    values: [
                        `swagger-ui.css`,
                        `swagger-ui.css.map`,
                        `swagger-ui-bundle.js`,
                        `swagger-ui-bundle.js.map`,
                        `swagger-ui-standalone-preset.js`,
                        `swagger-ui-standalone-preset.js.map`
                    ]
                }
            },
            handler(this: openApiService, ctx: Context<{ file: string }, { $responseType: string }>) {
                const { file } = ctx.params;

                if (file.indexOf('.css') > -1) {
                    ctx.meta.$responseType = 'text/css';
                } else if (file.indexOf('.js') > -1) {
                    ctx.meta.$responseType = 'text/javascript';
                } else {
                    ctx.meta.$responseType = 'application/octet-stream';
                }

                const filePath = `${swaggerUiAssetPath}/${file}`;
                if (this.settings.returnAssetsAsStream) {
                    return fs.createReadStream(filePath);
                } else {
                    return fs.readFileSync(filePath);
                }
            }
        },
        ui: {
            rest: {
                path: '/ui',
                method: 'GET'
            },
            openapi: {
                summary: 'OpenAPI ui',
                description: 'You can provide any schema file in query param'
            },
            params: {
                url: {
                    $$oa: {
                        summary: 'Schema url'
                    },
                    type: 'string',
                    optional: true
                } as RuleString
            },
            async handler(this: openApiService, ctx: Context<{ url: string }, { $responseType: string }>): Promise<string> {
                ctx.meta.$responseType = 'text/html; charset=utf-8';

                return `
      <html lang="en">
        <head>
           <title>OpenAPI UI</title>
           <link rel="stylesheet" href="${this.settings.assetsPath}/swagger-ui.css"/>
           <style>
               body {
                margin: 0;
               }
            </style>
        </head>
        <body>

          <div id="swagger-ui">
            <p>Loading...</p>
            <noscript>If you see json, you need to update your dependencies</noscript>
          </div>

          <script src="${this.settings.assetsPath}/swagger-ui-bundle.js"></script>
          <script src="${this.settings.assetsPath}/swagger-ui-standalone-preset.js"></script>
          <script>
            window.onload = function() {
             SwaggerUIBundle({
               url: "${ctx.params.url || this.settings.schemaPath}",
               dom_id: '#swagger-ui',
               deepLinking: true,
               showExtensions: true,
               presets: [
                 SwaggerUIBundle.presets.apis,
                 SwaggerUIStandalonePreset,
               ],
               plugins: [
                 SwaggerUIBundle.plugins.DownloadUrl
               ],
               layout: "StandaloneLayout",
             });
            }
          </script>

        </body>
      </html>`;
            }
        }
    },
    methods: {
        getGenerator() {
            if (!this.generator) {
                throw new Error('no generator, bad initialization');
            }

            return this.generator;
        }
    },
    created() {
        this.generator = new MoleculerOpenAPIGenerator(this.broker, this.settings as OpenApiMixinSettings);
    },
    async started() {
        this.logger.info(`📜 OpenAPI Docs server is available`);
    }
};
