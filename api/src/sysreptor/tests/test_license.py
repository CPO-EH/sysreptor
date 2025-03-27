import json
from base64 import b64decode, b64encode
from datetime import timedelta
from unittest import mock
from uuid import uuid4

import pytest
from asgiref.sync import async_to_sync
from Cryptodome.Hash import SHA512
from Cryptodome.PublicKey import ECC
from Cryptodome.Signature import eddsa
from django.conf import settings
from django.contrib.auth.tokens import default_token_generator
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from django.utils.crypto import get_random_string
from rest_framework import status
from rest_framework.test import APIClient

from sysreptor.tasks.models import LicenseActivationInfo
from sysreptor.tasks.tasks import activate_license
from sysreptor.tests.mock import (
    api_client,
    create_project,
    create_project_type,
    create_public_key,
    create_template,
    create_user,
    override_configuration,
    update,
)
from sysreptor.users.models import APIToken
from sysreptor.utils import license


def assert_api_license_error(res):
    assert res.status_code == status.HTTP_403_FORBIDDEN
    assert res.data['code'] == 'license'


def generate_signing_key():
    private_key = ECC.generate(curve='ed25519')
    public_key = {
        'id': str(uuid4()),
        'algorithm': 'ed25519',
        'key': b64encode(private_key.public_key().export_key(format='DER')).decode(),
    }
    return private_key, public_key


def sign_license_data(license_data_str: str, public_key: dict, private_key):
    signer = eddsa.new(key=private_key, mode='rfc8032')
    signature = signer.sign(SHA512.new(license_data_str.encode()))
    return {
        'key_id': public_key['id'],
        'algorithm': public_key['algorithm'],
        'signature': b64encode(signature).decode(),
    }


def sign_license(license_data, keys):
    license_data_str = json.dumps(license_data)
    return b64encode(json.dumps({
        'data': license_data_str,
        'signatures': [sign_license_data(license_data_str, k[0], k[1]) for k in keys],
    }).encode()).decode()


def signed_license(keys, **kwargs):
    return sign_license({
        'users': 10,
        'valid_from': (timezone.now() - timedelta(days=30)).date().isoformat(),
        'valid_until': (timezone.now() + timedelta(days=30)).date().isoformat(),
    } | kwargs, keys)


@pytest.mark.django_db()
class TestCommunityLicenseRestrictions:
    @pytest.fixture(autouse=True)
    def setUp(self):
        self.password = get_random_string(length=32)
        self.user = create_user(is_superuser=True, password=self.password)
        self.user_regular = create_user(password=self.password)
        self.user_system = create_user(is_system_user=True, password=self.password)

        self.client = api_client(self.user)
        session = self.client.session
        session.setdefault('authentication_info', {})['reauth_time'] = timezone.now().isoformat()
        session.save()

        with mock.patch('sysreptor.utils.license.check_license', return_value={'type': license.LicenseType.COMMUNITY, 'users': 2, 'error': None}):
            yield

    def test_spellcheck_disabled(self):
        assert self.client.get(reverse('publicutils-settings')).data['features']['spellcheck'] is False
        assert_api_license_error(self.client.post(reverse('utils-spellcheck')))
        assert_api_license_error(self.client.post(reverse('utils-spellcheck-add-word')))

    def test_admin_privesc_disabled(self):
        assert self.user.is_admin
        assert 'admin' in self.client.get(reverse('pentestuser-self')).data['scope']
        assert_api_license_error(self.client.post(reverse('pentestuser-disable-admin-permissions')))
        assert_api_license_error( self.client.post(reverse('pentestuser-enable-admin-permissions')))

    def test_backup_api_disabled(self):
        self.client.force_authenticate(self.user_system)
        assert_api_license_error(self.client.post(reverse('utils-backup'), data={'key': settings.BACKUP_KEY}))

    def test_md2html_api_disabled(self):
        project = create_project()
        assert_api_license_error(self.client.post(reverse('pentestproject-md2html', kwargs={'pk': project.id})))

    def test_archiving_disabled(self):
        public_key = create_public_key(user=self.user)
        project = create_project(members=[self.user])
        assert_api_license_error(self.client.post(reverse('userpublickey-list', kwargs={'pentestuser_pk': 'self'}), data={'name': 'test', 'public_key': public_key.public_key}))
        assert_api_license_error(self.client.post(reverse('pentestproject-archive', kwargs={'pk': project.pk})))

    def test_history_disabled(self):
        pt = create_project_type()
        p = create_project(project_type=pt, members=[self.user])
        t = create_template()

        # No history entries created
        for o in [
            pt, pt.assets.first(),
            t, t.main_translation, t.images.first(),
            p, p.sections.first(), p.findings.first(), p.notes.first(), p.images.first(), p.files.first()]:
            assert o.history.all().count() == 0

        # History timeline API
        assert_api_license_error(self.client.get(reverse('findingtemplatetranslation-history-timeline', kwargs={'template_pk': t.id, 'pk': t.main_translation.id})))
        assert_api_license_error(self.client.get(reverse('projecttype-history-timeline', kwargs={'pk': pt.id})))
        assert_api_license_error(self.client.get(reverse('pentestproject-history-timeline', kwargs={'pk': p.id})))
        assert_api_license_error(self.client.get(reverse('section-history-timeline', kwargs={'project_pk': p.id, 'id': p.sections.first().section_id})))
        assert_api_license_error(self.client.get(reverse('finding-history-timeline', kwargs={'project_pk': p.id, 'id': p.findings.first().finding_id})))
        assert_api_license_error(self.client.get(reverse('projectnotebookpage-history-timeline', kwargs={'project_pk': p.id, 'id': p.notes.first().note_id})))

        # History API
        h_url_kwargs = {'history_date': timezone.now().isoformat()}
        assert_api_license_error(self.client.get(reverse('findingtemplatehistory-detail', kwargs=h_url_kwargs | {'template_pk': t.id})))
        assert_api_license_error(self.client.get(reverse('projecttypehistory-detail', kwargs=h_url_kwargs | {'projecttype_pk': pt.id})))
        assert_api_license_error(self.client.get(reverse('projecttypehistory-asset-by-name', kwargs=h_url_kwargs | {'projecttype_pk': pt.id, 'filename': pt.assets.first().name})))
        p_url_kwargs = h_url_kwargs | {'project_pk': p.id}
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-detail', kwargs=p_url_kwargs)))
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-section', kwargs=p_url_kwargs | {'id': p.sections.first().section_id})))
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-finding', kwargs=p_url_kwargs | {'id': p.findings.first().finding_id})))
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-note', kwargs=p_url_kwargs | {'id': p.notes.first().note_id})))
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-image-by-name', kwargs=p_url_kwargs | {'filename': p.images.first().name})))
        assert_api_license_error(self.client.get(reverse('pentestprojecthistory-file-by-name', kwargs=p_url_kwargs | {'filename': p.files.first().name})))

    def test_prevent_login_of_nonsuperusers(self):
        self.client.force_authenticate(None)
        assert_api_license_error(self.client.post(reverse('auth-login'), data={
            'username': self.user_regular.username,
            'password': self.password,
        }))

    def test_system_users_api_access_allowed(self):
        api_token = APIToken.objects.create(user=self.user_system)
        assert api_client().get(reverse('utils-license'), HTTP_AUTHORIZATION='Bearer ' + api_token.token_formatted).status_code == 200

    def test_ignore_must_change_password(self):
        update(self.user, must_change_password=True)

        self.client.force_authenticate(None)
        res = self.client.post(reverse('auth-login'), data={
            'username': self.user.username,
            'password': self.password,
        })
        assert res.status_code == 200, res.data
        assert res.data['status'] == 'success'

    def test_prevent_create_non_superusers(self):
        self.user_regular.delete()
        self.user_system.delete()
        assert_api_license_error(self.client.post(reverse('pentestuser-list'), data={
            'username': 'new-user1',
            'password': self.password,
            'is_superuser': False,
        }))

        assert self.client.post(reverse('pentestuser-list'), data={
            'username': 'new-user2',
            'password': self.password,
            'is_superuser': True,
        }).status_code == 201

    @override_configuration(LOCAL_USER_AUTH_ENABLED=False)
    def test_local_auth_always_enabled(self):
        self.client.logout()
        res = self.client.post(reverse('auth-login'), data={'username': self.user.username, 'password': self.password})
        assert res.status_code == 200

    @override_configuration(REMOTE_USER_AUTH_ENABLED=True)
    def test_prevent_login_remoteuser(self):
        self.client.logout()
        assert_api_license_error(self.client.post(reverse('auth-login-remoteuser')))

    @override_configuration(LOCAL_USER_AUTH_ENABLED=True, FORGOT_PASSWORD_ENABLED=True)
    def test_prevent_forgot_password(self):
        assert_api_license_error(self.client.post(reverse('auth-forgot-password-send'), data={'email': self.user.email}))
        data = {'user': self.user.id, 'token': default_token_generator.make_token(self.user), 'password': get_random_string(32)}
        assert_api_license_error(self.client.post(reverse('auth-forgot-password-check'), data=data))
        assert_api_license_error(self.client.post(reverse('auth-forgot-password-reset'), data=data))

    def test_prevent_login_oidc(self):
        self.client.logout()
        assert_api_license_error(self.client.post(reverse('auth-login-oidc-begin', kwargs={'oidc_provider': 'azure'})))
        assert_api_license_error(self.client.post(reverse('auth-login-oidc-complete', kwargs={'oidc_provider': 'azure'})))

    def test_prevent_create_system_users(self):
        with pytest.raises(license.LicenseError):
            create_user(is_superuser=True, is_system_user=True)

    def test_user_count_limit(self):
        # Create user: Try to exceed limit by creating new superusers
        with pytest.raises(license.LicenseLimitExceededError):
            create_user(is_superuser=True)
        assert_api_license_error(self.client.post(reverse('pentestuser-list'), data={
            'username': 'new-user3',
            'password': self.password,
            'is_superuser': True,
        }))

        # Update is_superuser: Try to exceed limit by making existing users superusers
        with pytest.raises(license.LicenseError):
            update(self.user_regular, is_superuser=True)
        assert_api_license_error(self.client.patch(reverse('pentestuser-detail', kwargs={'pk': self.user_regular.pk}), data={'is_superuser': True}))

        # Disable user: should be allowed
        update(self.user_regular, is_active=False, is_superuser=True)

        # Update is_active: Try to exceed limit by enabling disabled superusers
        with pytest.raises(license.LicenseError):
            update(self.user_regular, is_active=True)

    def test_apitoken_limit(self):
        res1 = self.client.post(reverse('apitoken-list', kwargs={'pentestuser_pk': 'self'}), data={'name': 'test'})
        assert res1.status_code == 201
        res_token = api_client().get(reverse('pentestuser-detail', kwargs={'pk': 'self'}), HTTP_AUTHORIZATION='Bearer ' + res1.data['token'])
        assert res_token.status_code == 200

        with pytest.raises(license.LicenseLimitExceededError):
            APIToken.objects.create(user=self.user)

    def test_apitoken_no_expiry(self):
        assert_api_license_error(self.client.post(reverse('apitoken-list', kwargs={'pentestuser_pk': 'self'}), data={'name': 'test', 'expire_date': timezone.now().date().isoformat()}))


@pytest.mark.django_db()
class TestProfessionalLicenseRestrictions:
    @pytest.fixture(autouse=True)
    def setUp(self):
        self.password = get_random_string(length=32)
        self.user = create_user(is_user_manager=True, password=self.password)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

        with mock.patch('sysreptor.utils.license.check_license', return_value={'type': license.LicenseType.PROFESSIONAL, 'users': 1, 'error': None}):
            yield

    def test_user_count_limit(self):
        with pytest.raises(license.LicenseLimitExceededError):
            create_user(username='new-user1', password=self.password)
        # Create regular user
        assert_api_license_error(self.client.post(reverse('pentestuser-list'), data={
            'username': 'new-user2',
            'password': self.password,
        }))

        # Create system user
        create_user(is_system_user=True)


@pytest.mark.django_db()
class TestLicenseValidation:
    @pytest.fixture(autouse=True)
    def setUp(self):
        self.license_private_key, self.license_public_key = generate_signing_key()
        with mock.patch('sysreptor.utils.license.LICENSE_VALIDATION_KEYS', new=[self.license_public_key]):
            yield

    def signed_license(self, **kwargs):
        return signed_license(keys=[(self.license_public_key, self.license_private_key)], **kwargs)

    @pytest.mark.parametrize(('license_str', 'error'), [
        (None, None),
        ('', None),
        ('asdf', 'load'),
        (b64encode(b'asdf'), 'load'),
        (b64encode(json.dumps({'data': '{"valid_from": "2000-01-01", "valid_to": "3000-01-01", "users": 10}', 'signatures': []}).encode()), 'no valid signature'),  # Missing signatures
    ])
    def test_invalid_license_format(self, license_str, error):
        license_info = license.decode_and_validate_license(license_str)
        assert (license_info['type'] == license.LicenseType.PROFESSIONAL) is False
        if error:
            assert error in license_info['error'].lower()
        else:
            assert error is None

    @pytest.mark.parametrize(('valid', 'license_data', 'error'), [
        (False, {'valid_from': '3000-01-01'}, 'not yet valid'),
        (False, {'valid_until': '2000-01-1'}, 'expired'),
        (False, {'users': -10}, 'user count'),
        (False, {'users': 0}, 'user count'),
        (True, {}, None),
    ])
    def test_license_validation(self, valid, license_data, error):
        license_info = license.decode_and_validate_license(self.signed_license(**license_data))
        assert (license_info['type'] == license.LicenseType.PROFESSIONAL) is valid
        if not valid:
            assert error in license_info['error'].lower()
        else:
            assert not license_info['error']

    def test_user_limit_exceeded(self):
        create_user()
        create_user()

        license_info = license.decode_and_validate_license(self.signed_license(users=1))
        assert license_info['type'] != license.LicenseType.PROFESSIONAL
        assert 'limit exceeded' in license_info['error']

    def test_invalid_signature(self):
        license_data = json.dumps({
            'users': 10,
            'valid_from': '2000-01-01',
            'valid_until': '3000-01-01',
        })
        signer = eddsa.new(key=ECC.generate(curve='ed25519'), mode='rfc8032')
        signature = signer.sign(SHA512.new(license_data.encode()))
        license_info = license.decode_and_validate_license(b64encode(json.dumps({
            'data': license_data,
            'signatures': [{
                'key_id': self.license_public_key['id'],
                'algorithm': self.license_public_key['algorithm'],
                'signature': b64encode(signature).decode(),
            }],
        }).encode()).decode())
        assert license_info['type'] != license.LicenseType.PROFESSIONAL
        assert 'no valid signature' in license_info['error'].lower()

    def test_multiple_signatures_only_1_valid(self):
        license_1 = self.signed_license()
        license_content = json.loads(b64decode(license_1))
        license_content['signatures'].append({
            'key_id': str(uuid4()),
            'algorithm': 'ed25519',
            'signature': b64encode(eddsa.new(key=ECC.generate(curve='ed25519'), mode='rfc8032').sign(SHA512.new(license_content['data'].encode()))).decode(),
        })
        license_2 = b64encode(json.dumps(license_content).encode())
        license_info = license.decode_and_validate_license(license_2)
        assert license_info['type'] == license.LicenseType.PROFESSIONAL


@pytest.mark.django_db()
class TestLicenseActivationInfo:
    @pytest.fixture(autouse=True)
    def setUp(self):
        self.license_private_key, self.license_public_key = generate_signing_key()
        self.license_community = None
        self.license_invalid = 'invalid license string'
        self.license_professional = signed_license(keys=[(self.license_public_key, self.license_private_key)])
        self.license_professional2 = signed_license(keys=[(self.license_public_key, self.license_private_key)], users=20)
        self.license_expired = signed_license(keys=[(self.license_public_key, self.license_private_key)], valid_until=(timezone.now() - timedelta(days=1)).date().isoformat())

        def real_check_license():
            return license.decode_and_validate_license(settings.LICENSE)

        with mock.patch('sysreptor.utils.license.LICENSE_VALIDATION_KEYS', new=[self.license_public_key]), \
             mock.patch('sysreptor.utils.license.check_license', new=real_check_license), \
             mock.patch('sysreptor.tasks.tasks.activate_license_request', return_value={'status': 'ok', 'license_info': {'last_activation_time': timezone.now().isoformat()}}):
            yield

    @pytest.mark.parametrize(('name_old', 'name_new', 'created'), [
        ('license_community', 'license_community', False),
        ('license_community', 'license_invalid', False),
        ('license_community', 'license_professional', True),
        ('license_professional', 'license_professional', False),
        ('license_professional', 'license_professional2', True),
        ('license_professional', 'license_community', True),
        ('license_professional', 'license_expired', True),
    ])
    def test_license_activation_info_created(self, name_old, name_new, created):
        with override_settings(LICENSE=getattr(self, name_old)):
            activation_info_old = LicenseActivationInfo.objects.current()
        with override_settings(LICENSE=getattr(self, name_new)):
            async_to_sync(activate_license)(None)
            activation_info_new = LicenseActivationInfo.objects.order_by('-created').first()

        assert (activation_info_old != activation_info_new) == created
