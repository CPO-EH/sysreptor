from django.core.serializers.json import DjangoJSONEncoder
from django.db import models

from sysreptor.utils.crypto.fields import EncryptedField
from sysreptor.utils.fielddefinition.types import FieldDefinition
from sysreptor.utils.fielddefinition.utils import HandleUndefinedFieldsOptions, ensure_defined_structure
from sysreptor.utils.fielddefinition.validators import FieldValuesValidator
from sysreptor.utils.utils import copy_keys, merge, omit_keys


class CustomFieldsMixin(models.Model):
    custom_fields = models.JSONField(encoder=DjangoJSONEncoder, default=dict, blank=True)

    class Meta:
        abstract = True

    @property
    def field_definition(self) -> FieldDefinition:
        return None

    @property
    def core_field_names(self) -> list[str]:
        return []

    @property
    def data(self) -> dict:
        """
        Return a dict of all field values.
        Sets default values, if a field is not defined.
        Does not include data of undefined fields not present in the definition.
        """
        return self.get_data()

    @property
    def data_all(self) -> dict:
        return self.get_data(include_unknown=True)

    def get_data(self, include_unknown=False) -> dict:
        # Build dict of all current values
        # Merge core fields stored directly on the model instance and custom_fields stored as dict
        out = self.custom_fields.copy()
        for k in self.core_field_names:
            out[k] = getattr(self, k)

        # recursively check for undefined fields and set default value
        out = ensure_defined_structure(
            value=out,
            definition=self.field_definition,
            handle_undefined=HandleUndefinedFieldsOptions.FILL_NONE,
            include_unknown=include_unknown)

        return out

    def update_data(self, value: dict):
        # Merge with previous custom data
        value = merge(self.data, value)

        # Validate data
        FieldValuesValidator(self.field_definition)(value)

        # Distribute to model fields
        for k, v in copy_keys(value, self.core_field_names).items():
            setattr(self, k, v)
        self.custom_fields = self.custom_fields | omit_keys(value, self.core_field_names)


class EncryptedCustomFieldsMixin(CustomFieldsMixin):
    custom_fields = EncryptedField(base_field=models.JSONField(encoder=DjangoJSONEncoder, default=dict, blank=True))

    class Meta(CustomFieldsMixin.Meta):
        abstract = True

