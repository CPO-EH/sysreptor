import functools
import json
from pathlib import Path

import jsonschema
import regex
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils.deconstruct import deconstructible

from sysreptor.utils.fielddefinition.types import (
    BaseField,
    CweField,
    FieldDataType,
    FieldDefinition,
    ObjectField,
    parse_field_definition,
)
from sysreptor.utils.utils import is_json_string


@functools.cache
def get_field_definition_schema():
    return jsonschema.Draft202012Validator(schema=json.loads((Path(__file__).parent / 'fielddefinition.schema.json').read_text()))


@deconstructible
class FieldDefinitionValidator:
    def __init__(self, core_fields: FieldDefinition|None = None, predefined_fields: FieldDefinition|None = None) -> None:
        self.core_fields = core_fields
        self.predefined_fields = predefined_fields

    def definition_contains(self, val: BaseField, ref: BaseField):
        """
        Check if data types and structure of field definitions match recursively
        The definition `ref` has to be included in `val`.
        `val` may extend the nested structure by adding fields, but may not remove any fields.
        """
        if val.type != ref.type:
            return False
        if val.type == FieldDataType.OBJECT:
            if set(ref.fields_dict.keys()).difference(val.fields_dict.keys()):
                return False
            return all([self.definition_contains(val[f.id], f) for f in ref.fields])
        elif val.type == FieldDataType.LIST:
            return self.definition_contains(val.items, ref.items)
        return True

    def __call__(self, value: list[dict]):
        try:
            get_field_definition_schema().validate(value)
        except jsonschema.ValidationError as ex:
            raise ValidationError('Invalid field definition') from ex

        try:
            parsed_value = parse_field_definition(value)
        except ValueError as ex:
            raise ValidationError(f'Invalid field definition: {ex.args[0]}') from ex
        except Exception as ex:
            raise ValidationError('Invalid field definition') from ex
        # validate core fields:
        #   required
        #   structure cannot be changed
        #   labels and default values can be changed
        if self.core_fields:
            for f in self.core_fields.fields:
                if f.id not in parsed_value:
                    raise ValidationError(f'Core field "{f.id}" is required')
                elif not self.definition_contains(parsed_value[f.id], f):
                    raise ValidationError(f'Cannot change structure of core field "{f.id}"')

        # validate predefined fields:
        #   not required
        #   base structure cannot be changed, but can be extended
        #   labels and default values can be changed
        if self.predefined_fields:
            for f in self.predefined_fields.fields:
                if f.id in parsed_value and not self.definition_contains(parsed_value[f.id], f):
                    raise ValidationError(f'Cannot change structure of predefined field "{f.id}"')


@deconstructible
class FieldValuesValidator:
    def __init__(self, field_definitions: FieldDefinition, require_all_fields=True) -> None:
        self.schema = self.compile_definition_to_schema(field_definitions=field_definitions, require_all_fields=require_all_fields)

    def compile_object(self, definition: FieldDefinition|ObjectField):
        return {
            'type': 'object',
            'additionalProperties': True,
            'properties': {f.id: self.compile_field(f) for f in definition.fields},
            'required': list(definition.field_dict.keys()),
        }

    def compile_field(self, definition: BaseField):
        field_type = definition.type
        if field_type in [FieldDataType.STRING, FieldDataType.MARKDOWN, FieldDataType.CVSS, FieldDataType.COMBOBOX, FieldDataType.JSON]:
            return {'type': ['string', 'null']}
        elif field_type == FieldDataType.DATE:
            return {'type': ['string', 'null'], 'format': 'date'}
        elif field_type == FieldDataType.NUMBER:
            return {'type': ['number', 'null']}
        elif field_type == FieldDataType.BOOLEAN:
            return {'type': ['boolean', 'null']}
        elif field_type == FieldDataType.ENUM:
            return {'type': ['string', 'null'], 'enum': [c.value for c in definition.choices] + [None]}
        elif field_type == FieldDataType.CWE:
            return {'type': ['string', 'null'], 'enum': [f"CWE-{c['id']}" for c in CweField.cwe_definitions()] + [None]}
        elif field_type == FieldDataType.USER:
            return {'type': ['string', 'null'], 'format': 'uuid'}
        elif field_type == FieldDataType.OBJECT:
            return self.compile_object(definition)
        elif field_type == FieldDataType.LIST:
            return {'type': 'array', 'items': self.compile_field(definition.items)}
        else:
            raise ValueError(
                f'Encountered invalid type in field definition: "{field_type}"')

    def compile_definition_to_schema(self, field_definitions: FieldDefinition, require_all_fields=True):
        schema = {
            "$schema": "https://json-schema.org/draft/2019-09/schema",
            **self.compile_object(field_definitions),
        }
        if not require_all_fields:
            schema['required'] = []
        return jsonschema.Draft202012Validator(schema=schema)

    def __call__(self, value: dict):
        try:
            self.schema.validate(value)
        except jsonschema.ValidationError as ex:
            raise ValidationError('Data does not match field definition') from ex


@deconstructible
class JsonSchemaValidator:
    def __init__(self, schema: dict):
        self.schema = schema

    def __call__(self, value: dict|str):
        if not isinstance(value, dict):
            try:
                value = json.loads(value)
            except (json.JSONDecodeError, TypeError) as ex:
                raise ValidationError('Invalid data: Not a valid JSON object') from ex

        try:
            jsonschema.validate(value, self.schema)
        except jsonschema.ValidationError as ex:
            raise ValidationError(f'Invalid data: does not match JSON schema: {ex}') from ex
        except (jsonschema.SchemaError, Exception) as ex:
            raise ValidationError(f'Invalid JSON schema: {ex}') from ex


@deconstructible
class RegexPatternValidator:
    def __init__(self, pattern: str):
        self.pattern = pattern

    def __call__(self, data: str):
        try:
            res = regex.match(pattern=self.pattern, string=data, timeout=settings.REGEX_VALIDATION_TIMEOUT.total_seconds())
            if not res:
                raise ValidationError(f'Invalid format: Value does not match pattern /{self.pattern}/')
        except TimeoutError as ex:
            raise ValidationError('Regex timeout') from ex
        except regex.error as ex:
            raise ValidationError('Invalid regex pattern') from ex


@deconstructible
class JsonStringValidator:
    def __call__(self, data):
        if not is_json_string(data):
            raise ValidationError('Invalid data: Not a valid JSON string')


@deconstructible
class BooleanValidatorWrapper:
    def __init__(self, validator_fn):
        self.validator_fn = validator_fn

    def __call__(self, data):
        try:
            res = self.validator_fn(data)
            if res is False:
                raise ValidationError('Invalid value')
        except ValidationError:
            raise
        except Exception as ex:
            raise ValidationError() from ex
