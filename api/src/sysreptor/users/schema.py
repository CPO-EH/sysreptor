from drf_spectacular.extensions import OpenApiAuthenticationExtension
from drf_spectacular.plumbing import build_bearer_security_scheme_object


class APITokenAuthenticationExtension(OpenApiAuthenticationExtension):
    target_class = 'sysreptor.users.auth.APITokenAuthentication'
    name = 'API Token'

    def get_security_definition(self, auto_schema):
        return build_bearer_security_scheme_object(header_name='Authorization', token_prefix='Bearer')  # noqa: S106
