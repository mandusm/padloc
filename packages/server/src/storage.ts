// @ts-ignore
import level from "level";
import { Storage, Storable, StorableConstructor, StorageListOptions } from "@padloc/core/src/storage";
import { Err, ErrorCode } from "@padloc/core/src/error";
import { AwsRegion } from "aws-sdk/clients/servicequotas";
import DynamoDB from "aws-sdk/clients/dynamodb";
import { CredentialProviderChain } from "aws-sdk";

export class LevelDBStorage implements Storage {
    private _db: any;

    constructor(public path: string) {
        this._db = level(`${this.path}`);
    }

    async get<T extends Storable>(cls: StorableConstructor<T> | T, id: string) {
        const res = cls instanceof Storable ? cls : new cls();
        try {
            const raw = await this._db.get(`${res.kind}_${id}`);
            return res.fromJSON(raw);
        } catch (e) {
            if (e.notFound) {
                throw new Err(ErrorCode.NOT_FOUND, `Cannot find object: ${res.kind}_${id}`);
            } else {
                throw e;
            }
        }
    }

    async save<T extends Storable>(obj: T) {
        await this._db.put(`${obj.kind}_${obj.id}`, obj.toJSON());
    }

    async delete<T extends Storable>(obj: T) {
        await this._db.del(`${obj.kind}_${obj.id}`);
    }

    async clear() {
        throw "not implemented";
    }

    async list<T extends Storable>(
        cls: StorableConstructor<T>,
        { offset = 0, limit = Infinity, filter, lt, gt, reverse }: StorageListOptions<T> = {}
    ): Promise<T[]> {
        return new Promise((resolve, reject) => {
            const results: T[] = [];
            const kind = new cls().kind;

            const opts: any = { reverse };
            typeof lt !== "undefined" && (opts.lt = lt);
            typeof gt !== "undefined" && (opts.gt = gt);

            const stream = this._db.createReadStream(opts);

            stream
                .on("data", ({ key, value }: { key: string; value: string }) => {
                    if (results.length >= limit || key.indexOf(kind + "_") !== 0) {
                        return;
                    }
                    try {
                        const item = new cls().fromJSON(value);
                        if (!filter || filter(item)) {
                            if (offset) {
                                offset--;
                            } else {
                                results.push(item);
                            }
                        }
                    } catch (e) {
                        console.error(
                            `Failed to load ${key}:${JSON.stringify(JSON.parse(value), null, 4)} (Error: ${e})`
                        );
                    }
                    if (results.length >= limit) {
                        resolve(results);
                        stream.destroy();
                    }
                })
                .on("error", (err: Error) => reject(err))
                .on("close", () => reject("Stream closed unexpectedly."))
                .on("end", () => resolve(results));
        });
    }
}

// Add support for AWS DynamoDB
// Limitations with DynamoDB is that Total Item Size is only 400KB
// This means that a Vault can not exceed 400KB In size with the current
// Storage Implimentation as is. That's about 500 Standard Items
export class DynamoDBStorage implements Storage {
    private _db: any;
    private table: string;

    constructor(public credentials: CredentialProviderChain, region: AwsRegion, table: string) {
        this._db = new DynamoDB({ credentialProvider: credentials, region: region });
        this.table = table;
    }

    async get<T extends Storable>(cls: StorableConstructor<T> | T, id: string) {
        try {
            const res = cls instanceof Storable ? cls : new cls();
            const raw = await this._db
                .getItem({
                    Key: {
                        storeable: {
                            S: `${res.kind}_${id}`
                        }
                    },
                    TableName: this.table
                })
                .promise();

            // DynamoDB does not return an error on empty result.
            // Checking whether the _item_ property is defined to
            // determine whether the Item is not found.

            if (typeof raw.Item === "undefined") {
                throw new Err(ErrorCode.NOT_FOUND);
            } else {
                return res.fromJSON(raw.Item.secret.S);
            }
        } catch (e) {
            throw e;
        }
    }

    async save<T extends Storable>(obj: T) {
        await this._db
            .putItem({
                Item: {
                    storeable: {
                        S: `${obj.kind}_${obj.id}`
                    },
                    secret: {
                        S: obj.toJSON()
                    }
                },
                TableName: this.table
            })
            .promise();
    }

    async delete<T extends Storable>(obj: T) {
        await this._db
            .deleteItem({
                Key: {
                    storeable: {
                        S: `${obj.kind}_${obj.id}`
                    }
                },
                TableName: this.table
            })
            .promise();
    }

    async clear() {
        throw "not implemented";
    }
}
