import { ServiceBroker } from 'moleculer';
import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import { OA_GENERATE_DOCS_INPUT, OA_GENERATE_DOCS_OUTPUT, mixin } from '../src/index.js';
import ApiGateway from 'moleculer-web';

describe("Reproduction of $$oa extra keys issue", () => {
    const broker = new ServiceBroker({
        logLevel: 'error',
    });

    beforeAll(async () => {
        const service = {
            name: "test-oa",
            actions: {
                test: {
                    rest: "POST /test",
                    params: {
                        data: {
                            type: "object",
                            props: {
                                id: { 
                                    type: "string", 
                                    $$oa: { 
                                        title: "MyID",
                                        example: "123",
                                        description: "ID description"
                                    } 
                                },
                                nested: {
                                    type: "object",
                                    $$oa: {
                                        title: "NestedTitle",
                                        example: { a: 1 }
                                    },
                                    props: {
                                        a: "number"
                                    }
                                }
                            }
                        }
                    },
                    handler(ctx: any) { return ctx.params; }
                }
            }
        };
        await broker.createService(service);
        
        const apiService = {
            name: "api",
            mixins: [ApiGateway],
            settings: {
                port: 0,
                routes: [
                    {
                        path: "/api",
                        autoAliases: true
                    }
                ]
            }
        };
        await broker.createService(apiService);

        const openapiService: any = {
            name: "openapi",
            mixins: [mixin],
            settings: {
                openapi: {
                    info: { title: "Test API", version: "1.0.0" }
                }
            }
        };
        await broker.createService(openapiService);

        await broker.start();
        await new Promise(resolve => setTimeout(resolve, 1000));
    });

    afterAll(() => broker.stop());

    it("should include title and example from $$oa in the generated openapi", async () => {
        const json = await broker.call<OA_GENERATE_DOCS_OUTPUT, OA_GENERATE_DOCS_INPUT>("openapi.generateDocs", {
            version: '3.1'
        });

        const schemas = json.components?.schemas || {};
        const schemaName = 'test-oa.test.data';
        const idSchema = (schemas[schemaName] as any).properties.id;
        
        expect(idSchema.title).toBe("MyID");
        expect(idSchema.example).toBe("123");
        expect(idSchema.description).toBe("ID description");

        const nestedSchema = (schemas[schemaName] as any).properties.nested;
        expect(nestedSchema.title).toBe("NestedTitle");
        expect(nestedSchema.example).toEqual({ a: 1 });
    });
});
