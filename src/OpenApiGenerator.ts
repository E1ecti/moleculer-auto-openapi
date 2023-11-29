import { OpenAPIV3, OpenAPIV3_1 as OA3_1 } from 'openapi-types';
import { ValidationRule, ValidationRuleObject, ValidationSchema } from 'fastest-validator';
import { commonOpenApi, FastestValidatorType, openApiServiceOpenApi, TemplateVariables, tSystemParams } from './types/index.js';
import { getAlphabeticSorter, matchAll, normalizePath } from './commons.js';
import { LoggerInstance } from 'moleculer';
import { Alias } from './objects/Alias.js';
import { FastestValidatorConverter } from './Converters/FastestValidatorConverter.js';
import {
    ALLOWING_BODY_METHODS,
    BODY_PARSERS_CONTENT_TYPE,
    DEFAULT_CONTENT_TYPE,
    DEFAULT_MULTI_PART_FIELD_NAME,
    DEFAULT_SUMMARY_TEMPLATE,
    EOAExtensions,
    HTTP_METHODS,
    multiOAProperties,
    OpenApiVersionsSupported,
    UNRESOLVED_ACTION_NAME
} from './constants.js';
import { OpenApiMerger } from './OpenApiMerger.js';
import { OptionalOrFalse, SubOptionalOrFalse } from './types/utils.js';

type parametersExtracted = {
    parameters?: Array<OA3_1.ParameterObject>;
    requestBody?: OA3_1.OperationObject['requestBody'];
};

export class OpenApiGenerator {
    private components: OA3_1.ComponentsObject = {
        schemas: {},
        responses: {},
        parameters: {},
        examples: {},
        requestBodies: {},
        headers: {},
        securitySchemes: {},
        links: {},
        callbacks: {},
        pathItems: {}
    };
    private readonly document: openApiServiceOpenApi;
    private converter: FastestValidatorConverter;

    constructor(
        private readonly logger: LoggerInstance,
        validator: FastestValidatorType,
        baseDocument: openApiServiceOpenApi
    ) {
        this.converter = new FastestValidatorConverter(validator);

        this.document = baseDocument;
    }

    public generate(openApiVersion: OpenApiVersionsSupported, aliases: Array<Alias>): OA3_1.Document {
        const tagsMap: Map<string, OA3_1.TagObject> = new Map<string, OA3_1.TagObject>();

        if ((this.document as { openapi?: string }).openapi) {
            this.logger.warn(`setting manually the openapi version is not supported`);
            delete (this.document as { openapi?: string }).openapi;
        }

        const document: OA3_1.Document & { servers: Array<OA3_1.ServerObject> } = {
            openapi: `${openApiVersion}.0`,
            ...this.document,
            servers: [],
            tags: [],
            components: this.cleanComponents(this.document.components)
        };

        //delete responses that end in the document
        if ((document as commonOpenApi).responses) {
            delete (document as commonOpenApi).responses;
        }

        const cachePathActions = new Map<string, string | undefined>();

        aliases.sort(getAlphabeticSorter('fullPath'));

        aliases.forEach((alias) => {
            if (!document.paths) {
                document.paths = {};
            }

            const route = alias.route;
            const { apiService, openApiService } = route;

            const openapiPath: string = this.formatParamUrl(normalizePath(alias.fullPath));
            const currentPath: OA3_1.PathItemObject = document.paths?.[openapiPath] ?? {};

            if (alias.isJokerAlias()) {
                currentPath.description = alias.actionSchema?.openapi?.description;
                currentPath.summary = alias.actionSchema?.openapi?.summary;
            }

            alias.getPaths().forEach((pathAction) => {
                const method = pathAction.method;
                const cacheKeyName = `${openapiPath}.${method}`;

                const currentMethod = currentPath[method];
                if (currentMethod) {
                    if (
                        currentMethod.servers?.length &&
                        alias.route.apiService.settings?.openapi?.server?.url &&
                        !currentMethod.servers?.find((srv) => srv.url === alias.route.apiService.settings?.openapi?.server?.url)
                    ) {
                        const server = alias.route.apiService.settings.openapi.server;
                        currentMethod.servers.push(server);
                        this.addServerToDocument(document, server);
                        return;
                    }

                    const actionFromCache = cachePathActions.get(cacheKeyName);
                    this.logger.warn(
                        `${method.toUpperCase()} ${openapiPath} is already register by action ${actionFromCache ?? '<unamedAction>'} skip`
                    );
                    return;
                }

                cachePathActions.set(cacheKeyName, pathAction.action?.name);

                const openApi = OpenApiMerger.merge(tagsMap, route, alias, pathAction.action, openApiService, apiService);

                // TODO need to pass merged openApi to parameter extraction !
                const { parameters, requestBody } = this.extractParameters(method, openapiPath, alias) ?? {};

                this.components = this.mergeComponents(this.components, this.cleanComponents(openApi.components));

                const openApiMethod: OA3_1.OperationObject & { servers: Array<OA3_1.ServerObject> } = {
                    summary: !alias.isJokerAlias() ? openApi?.summary : undefined,
                    description: !alias.isJokerAlias() ? openApi?.description : undefined,
                    operationId: openApi?.operationId,
                    servers: [],
                    externalDocs: openApi?.externalDocs,
                    security: openApi?.security,
                    tags: this.handleTags(document, tagsMap, openApi?.tags),
                    parameters,
                    requestBody,
                    responses: openApi?.responses
                };

                if (alias.route.apiService.settings?.openapi?.server) {
                    const server = alias.route.apiService.settings.openapi.server;
                    openApiMethod.servers.push(server);

                    this.addServerToDocument(document, server);
                }

                const templateVariables: TemplateVariables = {
                    summary: openApi?.summary ?? '',
                    action: alias.action ?? UNRESOLVED_ACTION_NAME,
                    autoAlias: alias.route.autoAliases ? '[autoAlias]' : ''
                };

                const summaryTemplate = alias.route?.openApiService?.settings?.summaryTemplate;
                if (typeof summaryTemplate === 'string' || summaryTemplate === undefined) {
                    openApiMethod.summary = Object.entries(templateVariables)
                        .reduce(
                            (previous, [k, v]) => {
                                return previous.replace(new RegExp(`{{${k}}}`, 'g'), v ?? '');
                            },
                            (summaryTemplate ?? DEFAULT_SUMMARY_TEMPLATE) as string
                        )
                        .trim();
                }
                if (typeof summaryTemplate === 'function') {
                    openApiMethod.summary = summaryTemplate(templateVariables);
                }

                (currentPath[method] as OA3_1.OperationObject) = openApiMethod;
            });

            document.paths[openapiPath] = currentPath;
        });

        document.tags?.sort(getAlphabeticSorter('name'));

        document.components = this.mergeComponents(document.components, this.components);

        return this.removeExtensions(document);
    }

    private addServerToDocument(document: OA3_1.Document, server: OA3_1.ServerObject) {
        if (!document.servers) {
            document.servers = [];
        }

        if (!document.servers.some((srv) => srv.url === server.url)) {
            document.servers.push(server);
        }
    }

    private mergeComponents(c1: OA3_1.ComponentsObject, c2: OA3_1.ComponentsObject): OA3_1.ComponentsObject {
        return Object.keys(c2).reduce(
            (acc, key) => {
                // @ts-ignore
                if (!Object.keys(c2?.[key]).length) {
                    return acc;
                }

                return {
                    ...acc,
                    // @ts-ignore
                    [key]: { ...c1[key], ...c2[key] }
                };
            },
            { ...c1 }
        ) as OA3_1.ComponentsObject;
    }

    private extractParameters(method: HTTP_METHODS, path: string, alias: Alias): parametersExtracted {
        const pathParameters = alias.openapi?.pathParameters
            ? alias.openapi.pathParameters.map((param) => ({
                  ...param,
                  in: 'path'
              }))
            : this.extractParamsFromUrl(path);

        const result: parametersExtracted & Required<Pick<parametersExtracted, 'parameters'>> = {
            parameters: [...pathParameters]
        };

        const excluded = pathParameters.map((params: OA3_1.ParameterObject) => params.name);

        if (['multipart', 'stream'].includes(alias.type ?? '')) {
            result.requestBody = alias.openapi?.requestBody ? alias.openapi?.requestBody : this.generateFileUploadBody(alias, excluded);

            return result;
        } else if (alias.openapi?.queryParameters || alias.openapi?.requestBody || (alias.actionSchema?.params && alias.action)) {
            const actionParams = alias?.actionSchema?.params ?? {};
            const metas = this.converter.getMetas(actionParams);
            const openApiMetas = metas?.$$oa ?? {};

            //query
            if (!alias.openapi?.queryParameters) {
                const queryParameters = this.getParameters(method, actionParams, false);
                Object.entries(queryParameters).forEach(([k, v]) => {
                    const schema = this.converter.getSchemaObjectFromRule(v) as OpenAPIV3.SchemaObject;

                    if (!schema) {
                        return undefined;
                    }

                    const component = this.getComponent(schema);

                    const schemaParameter: OA3_1.ParameterObject = {
                        name: k,
                        in: 'query',
                        style: schema.type === 'object' ? 'deepObject' : undefined,
                        explode: schema.type === 'object' ? true : undefined,
                        // required need to be true, or undefined
                        required: component[EOAExtensions.optional] !== true || undefined,
                        schema
                    };

                    if (!excluded.includes(k)) {
                        result.parameters.push(schemaParameter);
                        return;
                    }

                    //handle the case where the pathParameter is defined in params
                    result.parameters = result.parameters.map((parameter) => {
                        if (parameter.name !== k) {
                            return parameter;
                        }

                        return {
                            ...schemaParameter,
                            in: 'path',
                            required: true
                        };
                    });
                });
            } else {
                result.parameters = alias.openapi.queryParameters.map((param) => ({ ...param, in: 'query' }));
            }

            //body
            if (!alias.openapi?.requestBody) {
                if (!alias.action) {
                    //in theory will never happen
                    throw new Error('something is wrong');
                }
                const bodyParameters = this.getParameters(method, actionParams, true);
                if (Object.keys(bodyParameters).length > 0) {
                    const currentBodyParameters = {
                        ...metas,
                        ...bodyParameters
                    };

                    const schema = this.createRequestBodyFromParams(alias.action, currentBodyParameters, excluded);

                    const tmpContentTypes: Array<string> = Object.entries(alias.route?.bodyParsers || {})
                        .filter(([, v]) => Boolean(v))
                        .flatMap(([parser]) => BODY_PARSERS_CONTENT_TYPE[parser as keyof typeof BODY_PARSERS_CONTENT_TYPE] ?? []);

                    // TODO specify input content type ? + allow to specify one ? allow to force one ?
                    const contentTypes = (tmpContentTypes?.length
                        ? tmpContentTypes
                        : [alias.route?.openApiService?.settings?.defaultResponseContentType]) ?? [DEFAULT_CONTENT_TYPE];

                    let required = false;
                    if (this.isReferenceObject(schema)) {
                        const schemaRef = this.getComponentByRef<OpenAPIV3.BaseSchemaObject>(schema.$ref);

                        if (!schemaRef) {
                            throw new Error(`fail to get schema from path ${schema.$ref}`);
                        }

                        required = (schemaRef.required ?? []).length > 0;
                    }

                    result.requestBody = {
                        description: openApiMetas.description,
                        summary: openApiMetas.summary,
                        required,
                        content: Object.fromEntries(
                            contentTypes.map((contentType) => [contentType, { schema }]) as Array<[string, OA3_1.MediaTypeObject]>
                        )
                    };
                }
            } else {
                result.requestBody = alias.openapi.requestBody;
            }
        }
        return result;
    }

    private getParameters(method: HTTP_METHODS, params: ValidationSchema, body: boolean): Record<string, ValidationRule> {
        const defaultInBody = ALLOWING_BODY_METHODS.includes(method);
        return Object.fromEntries(
            Object.entries(this.converter.getValidationRules(params))
                .map(([k, param]: [string, ValidationRule | undefined | any]): [string, ValidationRule] | undefined => {
                    const openApiInParameter = (param as ValidationRuleObject)?.$$oa?.in;
                    const inBody = openApiInParameter ? openApiInParameter === 'body' : defaultInBody;

                    if (inBody !== body) {
                        return;
                    }

                    return [k, param];
                })
                .filter(Boolean) as Array<[string, ValidationRule]>
        );
    }

    /**
     * file upload use a specific way to works, so we need to handle it here
     *
     * @link https://moleculer.services/docs/0.14/moleculer-web.html#File-upload-aliases
     */
    private generateFileUploadBody(alias: Alias, excluded: Array<string>): OA3_1.RequestBodyObject {
        const typeBodyParser = alias.type
            ? BODY_PARSERS_CONTENT_TYPE[alias.type as keyof typeof BODY_PARSERS_CONTENT_TYPE]
            : BODY_PARSERS_CONTENT_TYPE.multipart;

        const schema: OA3_1.MediaTypeObject['schema'] = {};

        const binarySchema: { type: OA3_1.NonArraySchemaObjectType; format: string } = {
            type: 'string',
            format: 'binary'
        };

        if (alias.type === 'stream') {
            schema.type = binarySchema.type;
            schema.format = binarySchema.format;
        } else {
            if (alias.actionSchema?.params?.$$root === true) {
                throw new Error('$$root parameters is not supported on multipart');
            }

            const filesLimit = alias.busboyConfig?.limits?.files ?? alias?.route?.busboyConfig?.limits?.files;
            const fileField = alias.route.openApiService?.settings?.multiPartFileFieldName ?? DEFAULT_MULTI_PART_FIELD_NAME;
            schema.allOf = [
                {
                    type: 'object',
                    properties: {
                        [fileField]:
                            filesLimit === 1
                                ? binarySchema
                                : {
                                      type: 'array',
                                      items: binarySchema,
                                      maxItems: filesLimit
                                  }
                    },
                    required: [fileField]
                }
            ];

            // actually, moleculer-web doesn't handle fastest-validator params when uploading a file .
            // so params will not be checked by the validator ! but can be used to define it
            if (alias.action && alias.actionSchema?.params) {
                //merge schema with field "file"
                const paramsSchema = this.createRequestBodyFromParams(alias.action, alias.actionSchema.params ?? {}, excluded);
                if (paramsSchema) {
                    schema.allOf.push(paramsSchema);
                }
            }
        }

        return {
            required: true,
            content: {
                [typeBodyParser[0]]: {
                    schema
                }
            }
        } as OA3_1.RequestBodyObject;
    }

    private isReferenceObject(component: any): component is OA3_1.ReferenceObject {
        return !!(component as OA3_1.ReferenceObject)?.$ref;
    }

    private getComponent(component: OA3_1.ReferenceObject | OA3_1.SchemaObject): OA3_1.SchemaObject {
        if (!this.isReferenceObject(component)) {
            return component;
        }

        const refComponent = this.getComponentByRef(component.$ref);
        if (!refComponent) {
            throw new Error(`fail to get component "${component.$ref}`);
        }
        return refComponent;
    }

    private getComponentByRef<T extends Record<string, unknown>>(path: string): T | undefined {
        const pathSegments = path.split('/').filter((segment) => segment !== ''); // Séparer le chemin en segments

        //bad path format
        if (
            pathSegments.length < 4 ||
            pathSegments[0] !== '#' ||
            pathSegments[1] !== 'components' ||
            !Object.keys(this.components).includes(pathSegments[2])
        ) {
            return undefined;
        }

        return pathSegments.slice(2).reduce((currentObject: Record<string, any> | undefined, segment) => {
            return currentObject && currentObject.hasOwnProperty(segment) ? currentObject[segment] : undefined;
        }, this.components) as unknown as T;
    }

    createRequestBodyFromParams(
        rootSchemeName: string,
        obj: ValidationSchema,
        exclude: Array<string> = [],
        parentNode: { default?: any } = {}
    ): OA3_1.SchemaObject | OA3_1.ReferenceObject | undefined {
        if (obj.$$root === true) {
            return this.converter.getSchemaObjectFromRootSchema(obj);
        }

        const rootRules = this.converter.getSchemaObjectFromSchema(obj);

        const rules: Record<string, OA3_1.SchemaObject> = Object.fromEntries(
            Object.entries(rootRules).filter(([name, rule]) => !exclude.includes(name) && rule)
        );

        return this._createSchemaComponentFromObject(rootSchemeName, rules, parentNode);
    }

    /**
     * extract params from /{table}
     * @param url
     * @returns {[]}
     */
    extractParamsFromUrl(url = ''): Array<OA3_1.ParameterObject> {
        return [...matchAll(/{(\w+)}/g, url).flat()].map((name) => ({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' }
        })) as Array<OA3_1.ParameterObject>;
    }
    /**
     * Convert moleculer params to openapi definitions(components schemas)
     * @param schemeName
     * @param obj
     * @param customProperties
     */
    _createSchemaComponentFromObject(
        schemeName: string,
        obj: Record<string, OA3_1.SchemaObject>,
        customProperties: { default?: any } = {}
    ): OA3_1.ReferenceObject {
        if (!this.components.schemas) {
            this.components.schemas = {};
        }

        const required: Array<string> = [];
        const properties = Object.fromEntries(
            Object.entries(obj).map(([fieldName, rule]: [string, OA3_1.SchemaObject]) => {
                const nextSchemeName = `${schemeName}.${fieldName}`;
                if (rule[EOAExtensions.optional] != true) {
                    required.push(fieldName);
                }

                return [fieldName, this._createSchemaPartFromRule(nextSchemeName, rule)];
            })
        );

        if (this.components.schemas[schemeName]) {
            this.logger.warn(`Generator - schema ${schemeName} already exist and will be overwrite`);
        }

        this.components.schemas[schemeName] = {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined,
            default: customProperties.default
        };

        return {
            $ref: `#/components/schemas/${schemeName}`
        };
    }

    /**
     * convert /:table to /{table}
     * @param url
     * @returns {string|string}
     */
    private formatParamUrl(url = ''): string {
        let start = url.indexOf('/:');
        if (start === -1) {
            return url;
        }

        const end = url.indexOf('/', ++start);

        if (end === -1) {
            return url.slice(0, start) + '{' + url.slice(++start) + '}';
        }

        return this.formatParamUrl(url.slice(0, start) + '{' + url.slice(++start, end) + '}' + url.slice(end));
    }

    private _createSchemaPartFromRule(nextSchemeName: string, rule: OA3_1.SchemaObject): OA3_1.SchemaObject | OA3_1.ReferenceObject {
        const systemParams: tSystemParams = this.extractSystemParams(rule as Record<string, unknown>);

        rule.description = systemParams.description;
        rule.title = systemParams.summary;
        rule.deprecated = systemParams.deprecated;

        if (rule.type == 'object' && rule.properties) {
            // create child schema per object
            return {
                summary: rule.title,
                deprecated: rule.deprecated,
                description: rule.description,
                ...this._createSchemaComponentFromObject(nextSchemeName, rule.properties, { default: rule.default })
            };
        }

        if (rule.type === 'array' && rule.items) {
            return {
                ...rule,
                items: this._createSchemaPartFromRule(nextSchemeName, rule.items as OA3_1.SchemaObject)
            };
        }

        if (multiOAProperties.some((property) => rule[property])) {
            let i = 0;
            multiOAProperties.forEach((property) => {
                if (!rule[property]) {
                    return;
                }

                rule[property] = (rule[property] as Array<OA3_1.SchemaObject>).map((schema) => {
                    if (schema.type !== 'object') {
                        return schema;
                    }

                    const schemeName = `${nextSchemeName}.${i++}`;

                    return this._createSchemaPartFromRule(schemeName, schema);
                });
            });
        }

        return rule;
    }

    private extractSystemParams(obj: Record<string, unknown> = {}): tSystemParams {
        return {
            optional: obj?.[EOAExtensions.optional] as boolean,
            description: obj?.[EOAExtensions.description] as string,
            summary: obj?.[EOAExtensions.summary] as string,
            deprecated: obj?.[EOAExtensions.deprecated] as boolean
        };
    }

    private removeExtensions<T>(obj: T): T {
        if (Array.isArray(obj)) {
            return obj.map((item) => this.removeExtensions(item)) as T;
        }

        if (typeof obj === 'object') {
            Object.values(EOAExtensions).forEach((extension) => {
                delete (obj as Record<string, unknown>)[extension];
            });

            return Object.fromEntries(
                Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
                    return [k, this.removeExtensions(v)];
                })
            ) as T;
        }

        return obj;
    }

    private cleanComponents(components: SubOptionalOrFalse<OA3_1.ComponentsObject> = {}): OA3_1.ComponentsObject {
        return Object.fromEntries(
            Object.entries(components).map(([k, v]: [string, OptionalOrFalse<OA3_1.ComponentsObject>]) => [
                k,
                Object.fromEntries(
                    // @ts-ignore
                    Object.entries(v)
                        .map(([key, value]) => (value === false ? undefined : [key, value]))
                        .filter(Boolean)
                )
            ])
        );
    }

    private handleTags(document: OA3_1.Document, tagsMap: Map<string, OA3_1.TagObject>, tags: Array<string> = []): Array<string> {
        const uniqTags = Array.from(new Set(tags));

        if (!document.tags) {
            document.tags = [];
        }

        uniqTags.forEach((tag) => {
            const tagObject: OA3_1.TagObject | undefined = tagsMap.get(tag);
            if (!document.tags!.some(({ name }) => name === tag) && tagObject) {
                document.tags!.push(tagObject);
            }
        });

        return uniqTags;
    }
}
